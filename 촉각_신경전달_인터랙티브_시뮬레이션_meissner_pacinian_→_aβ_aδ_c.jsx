import React, { useMemo, useState, useEffect, useRef } from "react";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Info } from "lucide-react";

/**
 * CUTANEOUS TACTILE TRANSDUCTION SIMULATOR
 * - 자극 → 기계수용체(마이이스너/파치니) → 기계개폐 Na+ 채널(ENaC 가정) → 수용기 전위 → 발화 → 말초전도(Aβ/Aδ/C)
 * - 오른쪽 하단: 두 점 식별(부위별 역치) 판단
 *
 * 단순화된 수학 모델:
 *  stimulus(t) = amp * sin(2π f t) * gate(t)  // gate는 자극 on/off
 *  receptor_gain = bandpass(f; f_low, f_high)
 *  adaptation = exp(-t/τ) (rapid adapting)
 *  V_rec(t) = stimulus(t) * receptor_gain * adaptation
 *  spike if V_rec crosses theta, refractory Tr
 *  conduction_delay = distance / velocity
 */

// 유틸: 선형 보간형 밴드패스 이득 (간단화)
function bandpassGain(freq: number, low: number, high: number) {
  if (freq <= 0) return 0;
  if (freq < low) return Math.max(0, (freq / low));
  if (freq > high) return Math.max(0, (high / freq));
  return 1; // 통과 대역
}

// 스파이크 생성기 (간단 임계치 + 불응기)
function generateSpikes(time: number[], vrec: number[], theta: number, refracMs: number) {
  const spikes: number[] = [];
  let lastSpikeT = -Infinity;
  for (let i = 1; i < time.length; i++) {
    const t = time[i];
    if (vrec[i - 1] < theta && vrec[i] >= theta) {
      if (t - lastSpikeT >= refracMs) {
        spikes.push(t);
        lastSpikeT = t;
      }
    }
  }
  return spikes;
}

// 간단한 축색 전도 속도 테이블 (m/s)
const velocities: Record<string, number> = {
  "Aβ": 50, // 33–75 m/s 범위 내 중간값
  "Aδ": 15, // 5–30 m/s
  "C": 1.5, // 0.5–2 m/s
};

// 부위별 두점식별 역치(mm) 단순 테이블
const twoPointThresholds: Record<string, number> = {
  손가락: 2, // 2–4 mm 중 2로 설정
  엄지: 3,
  손바닥: 10,
  손목: 20,
  전완: 35,
  상완: 40,
  어깨: 45,
};

// 파형 캔버스(SVG) 컴포넌트
function WavePlot({ time, y, yLabel, height = 120, yRange = [-1, 1] }: { time: number[]; y: number[]; yLabel: string; height?: number; yRange?: [number, number]; }) {
  const width = 520;
  const padding = 30;
  const tMin = time[0];
  const tMax = time[time.length - 1];

  const pts = time.map((t, i) => {
    const x = padding + ((t - tMin) / (tMax - tMin)) * (width - padding * 2);
    const yNorm = (y[i] - yRange[0]) / (yRange[1] - yRange[0]);
    const yy = height - padding - yNorm * (height - padding * 2);
    return `${x},${yy}`;
  }).join(" ");

  // 축
  return (
    <svg className="w-full" viewBox={`0 0 ${width} ${height}`}>
      <rect x={0} y={0} width={width} height={height} className="fill-transparent stroke-gray-300" />
      {/* y=0 line */}
      <line x1={padding} x2={width - padding} y1={height / 2} y2={height / 2} className="stroke-gray-300" />
      <polyline points={pts} className="fill-none stroke-current" />
      <text x={8} y={16} className="text-xs">{yLabel}</text>
      <text x={width - 60} y={16} className="text-xs">시간 (ms)</text>
    </svg>
  );
}

function SpikeRaster({ time, spikes, height = 80 }: { time: number[]; spikes: number[]; height?: number; }) {
  const width = 520;
  const padding = 30;
  const tMin = time[0];
  const tMax = time[time.length - 1];
  return (
    <svg className="w-full" viewBox={`0 0 ${width} ${height}`}>
      <rect x={0} y={0} width={width} height={height} className="fill-transparent stroke-gray-300" />
      {spikes.map((t, i) => {
        const x = padding + ((t - tMin) / (tMax - tMin)) * (width - padding * 2);
        return <line key={i} x1={x} x2={x} y1={10} y2={height - 10} className="stroke-current" />;
      })}
      <text x={8} y={16} className="text-xs">발화(raster)</text>
      <text x={width - 60} y={16} className="text-xs">시간 (ms)</text>
    </svg>
  );
}

export default function App() {
  // 제어 변수
  const [receptor, setReceptor] = useState<"Meissner" | "Pacinian">("Meissner");
  const [freq, setFreq] = useState(10); // Hz
  const [amp, setAmp] = useState(1); // arbitrary
  const [durationMs, setDurationMs] = useState(500); // ms
  const [theta, setTheta] = useState(0.5);
  const [tauMs, setTauMs] = useState(120); // 빠른 적응 타임상수(ms)
  const [refracMs, setRefracMs] = useState(8); // 불응기(ms)
  const [fiber, setFiber] = useState<"Aβ" | "Aδ" | "C">("Aβ");
  const [distanceCm, setDistanceCm] = useState(60); // 피부→척수 경로 길이 (cm)
  const [stimOn, setStimOn] = useState(true);

  // 두점식별
  const [region, setRegion] = useState<keyof typeof twoPointThresholds>("손가락");
  const [pointGap, setPointGap] = useState(3); // mm

  // 시간축
  const dt = 1; // ms
  const time = useMemo(() => Array.from({ length: Math.floor(durationMs / dt) + 1 }, (_, i) => i * dt), [durationMs]);

  // 수용기 대역
  const band = useMemo(() => {
    return receptor === "Meissner" ? { low: 2, high: 40 } : { low: 40, high: 500 };
  }, [receptor]);

  // 파형 생성
  const { stim, vrec, spikes, arrivalDelayMs } = useMemo(() => {
    const stim: number[] = [];
    const vrec: number[] = [];
    const f = freq;
    const g = bandpassGain(f, band.low, band.high);
    const a = amp;

    for (let i = 0; i < time.length; i++) {
      const t = time[i];
      const s = stimOn ? a * Math.sin(2 * Math.PI * (f / 1000) * t) : 0; // t ms → f/1000 변환
      stim.push(s);
      const adapt = Math.exp(-t / tauMs);
      vrec.push(s * g * adapt);
    }
    const spikes = generateSpikes(time, vrec, theta, refracMs);
    const vel = velocities[fiber];
    const arrivalDelayMs = (distanceCm / 100) / vel * 1000; // s → ms
    return { stim, vrec, spikes, arrivalDelayMs };
  }, [time, freq, amp, stimOn, tauMs, theta, refracMs, band.low, band.high, fiber, distanceCm]);

  // CNS 도달 스파이크 (지연 적용)
  const cnsSpikes = useMemo(() => spikes.map(t => t + arrivalDelayMs), [spikes, arrivalDelayMs]);

  const perceivedTwoPoints = useMemo(() => pointGap >= twoPointThresholds[region], [pointGap, region]);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">촉각 신경전달 인터랙티브 시뮬레이터</h1>
      <p className="text-sm opacity-80">자극 → 수용기(마이이스너/파치니) → ENaC 유사 Na+ 유입 → 수용기 전위 → 발화 → 말초전도(Aβ/Aδ/C) → CNS 도달. *교육용 단순화 모델*</p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>입력 & 수용기</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>수용기 타입</Label>
              <div className="flex gap-2">
                <Button variant={receptor === "Meissner" ? "default" : "secondary"} onClick={() => setReceptor("Meissner")}>Meissner (2–40 Hz)</Button>
                <Button variant={receptor === "Pacinian" ? "default" : "secondary"} onClick={() => setReceptor("Pacinian")}>Pacinian (40–500 Hz)</Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>자극 주파수 (Hz): {freq}</Label>
              <Slider value={[freq]} min={1} max={500} step={1} onValueChange={(v)=>setFreq(v[0])} />
            </div>
            <div className="space-y-2">
              <Label>자극 강도 (상대): {amp.toFixed(2)}</Label>
              <Slider value={[amp]} min={0} max={2} step={0.01} onValueChange={(v)=>setAmp(v[0])} />
            </div>
            <div className="flex items-center justify-between">
              <Label>자극 On/Off</Label>
              <Switch checked={stimOn} onCheckedChange={setStimOn} />
            </div>
            <div className="space-y-2">
              <Label>시뮬레이션 길이 (ms): {durationMs}</Label>
              <Slider value={[durationMs]} min={200} max={2000} step={10} onValueChange={(v)=>setDurationMs(v[0])} />
            </div>
            <div className="space-y-2">
              <Label>적응 타임상수 τ (ms): {tauMs}</Label>
              <Slider value={[tauMs]} min={40} max={400} step={5} onValueChange={(v)=>setTauMs(v[0])} />
            </div>
            <div className="space-y-2">
              <Label>발화 임계치 θ: {theta.toFixed(2)}</Label>
              <Slider value={[theta]} min={0.1} max={1.5} step={0.01} onValueChange={(v)=>setTheta(v[0])} />
            </div>
            <div className="space-y-2">
              <Label>불응기 (ms): {refracMs}</Label>
              <Slider value={[refracMs]} min={2} max={20} step={1} onValueChange={(v)=>setRefracMs(v[0])} />
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>축색 전도</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>섬유 유형</Label>
              <div className="flex gap-2">
                {(["Aβ","Aδ","C"] as const).map(t => (
                  <Button key={t} variant={fiber===t?"default":"secondary"} onClick={()=>setFiber(t)}>{t} ({velocities[t]} m/s)</Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>피부→척수 거리 (cm): {distanceCm}</Label>
              <Slider value={[distanceCm]} min={10} max={120} step={1} onValueChange={(v)=>setDistanceCm(v[0])} />
            </div>
            <div className="rounded-xl p-3 bg-muted">
              <div className="text-sm">전도 지연 ≈ <b>{arrivalDelayMs.toFixed(1)}</b> ms</div>
              <div className="text-xs opacity-70">delay = 거리/속도</div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>두 점 식별 (공간 분해능)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>부위</Label>
              <div className="flex flex-wrap gap-2">
                {Object.keys(twoPointThresholds).map((k) => (
                  <Button key={k} variant={region===k?"default":"secondary"} onClick={()=>setRegion(k as any)}>{k}</Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>두 점 간격 (mm): {pointGap}</Label>
              <Slider value={[pointGap]} min={1} max={50} step={1} onValueChange={(v)=>setPointGap(v[0])} />
            </div>
            <div className={`rounded-xl p-3 ${perceivedTwoPoints?"bg-emerald-100":"bg-amber-100"}`}>
              <div className="text-lg font-semibold">知覺: {perceivedTwoPoints?"두 점":"한 점"}</div>
              <div className="text-sm">역치(부위별): {twoPointThresholds[region]} mm</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>파형 시각화</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <WavePlot time={time} y={stim} yLabel="기계적 자극" yRange={[-amp, amp]} />
          <WavePlot time={time} y={vrec} yLabel="수용기 전위 (RA + 대역통과)" yRange={[-amp, amp]} />
          <SpikeRaster time={time} spikes={spikes} />
          <SpikeRaster time={time} spikes={cnsSpikes} />
          <div className="text-xs opacity-70">* 위 raster 2개는 각각 피부의 수용체 말단 및 CNS 도달 시점을 나타냅니다.</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>설명(요약)</CardTitle>
          <Info className="w-4 h-4 opacity-70" />
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <ul className="list-disc pl-5 space-y-1">
            <li><b>Meissner</b>: 저주파(2–40 Hz)·좁은 수용장·빠른 적응 → 촉각/Flutter.</li>
            <li><b>Pacinian</b>: 고주파(40–500 Hz)·넓은 수용장·빠른 적응 → 진동 감지.</li>
            <li>기계 자극이 ENaC 유사 <b>Na+ 채널</b>을 열어 <b>수용기 전위</b>를 생성(발생기 전위). 임계치 초과 시 활동전위가 발생.</li>
            <li><b>Aβ</b>(촉각) &gt; <b>Aδ</b>(빠른 통증/온도) &gt; <b>C</b>(느린 통증/온도) 순으로 전도속도가 빠릅니다.</li>
            <li>부위별 <b>두 점 식별 역치</b>는 수용장 크기/밀도 차이를 반영합니다(손가락 &lt; 전완 &lt; 어깨).</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
