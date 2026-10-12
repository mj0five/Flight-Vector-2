"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const landing = $("#landing");
const workspace = $("#workspace");
const notice = $("#notice");
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
const settingsDialog = $("#settingsDialog");

let currentFileName = "";
let currentBuffer = null;
let currentResult = null;
let currentWorker = null;
let selectedStage = 0;
let chartMode = "speed";
let chartGeometry = null;

const formatNumber = (value, digits = 1) => Number.isFinite(value)
  ? value.toLocaleString("fa-IR", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function currentSettings() {
  const optional = (selector) => {
    const value = Number($(selector).value);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    calibrationStart: Number($("#calStart").value),
    calibrationEnd: Number($("#calEnd").value),
    lowPassHz: Math.max(0, Number($("#cutoff").value) || 0),
    performanceEnd: optional("#performanceEnd"),
    tiltSigmaDeg: Math.max(0, Number($("#tiltSigma").value) || 0),
    barometerSigma: Math.max(0.5, Number($("#baroSigma").value) || 2.5),
    acc1GOverride: optional("#acc1G"),
  };
}

function setNotice(message, kind = "working") {
  notice.classList.remove("hidden");
  notice.dataset.kind = kind;
  notice.textContent = message;
}

function clearNotice() {
  notice.classList.add("hidden");
  notice.textContent = "";
}

function analyzeBuffer() {
  if (!currentBuffer) return;
  if (currentWorker) currentWorker.terminate();
  currentWorker = new Worker("worker.js");
  setNotice("در حال آماده‌سازی موتور محاسبات…");
  workspace.classList.add("hidden");
  currentWorker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      const percent = Math.round((data.update.fraction || 0) * 100);
      setNotice(`${data.update.detail || data.update.stage} · ${percent.toLocaleString("fa-IR")}٪`);
      return;
    }
    if (data.type === "error") {
      currentWorker.terminate();
      currentWorker = null;
      setNotice(data.message, "error");
      return;
    }
    currentWorker.terminate();
    currentWorker = null;
    currentResult = data.result;
    renderResult();
  };
  currentWorker.onerror = (event) => {
    setNotice(`خطای موتور محاسبات: ${event.message}`, "error");
  };
  const copy = currentBuffer.slice(0);
  currentWorker.postMessage({ buffer: copy, settings: currentSettings() }, [copy]);
}

function inspectBbl(buffer, name) {
  const text = new TextDecoder().decode(buffer.slice(0, 131072));
  const headers = [...text.matchAll(/^H (.+)$/gm)].map((match) => match[1]);
  const firmware = headers.find((value) => /Firmware revision/i.test(value));
  const acc1g = headers.find((value) => /acc_1G/i.test(value));
  setNotice(
    `${name} یک فایل BBL باینری است. ${headers.length.toLocaleString("fa-IR")} مدخل سربرگ خوانده شد${firmware ? `؛ ${firmware}` : ""}${acc1g ? `؛ ${acc1g}` : ""}. `
    + "برای اجرای زنجیره بصری، همین لاگ را در Betaflight Blackbox Explorer با همه فیلدها به CSV تبدیل کنید.",
    "warning",
  );
}

async function loadFile(file) {
  if (!file) return;
  currentFileName = file.name;
  currentBuffer = await file.arrayBuffer();
  if (file.name.toLowerCase().endsWith(".bbl")) {
    inspectBbl(currentBuffer, file.name);
    return;
  }
  analyzeBuffer();
}

function renderResult() {
  const result = currentResult;
  landing.classList.add("hidden");
  workspace.classList.remove("hidden");
  $("#newButton").disabled = false;
  clearNotice();

  $("#fileName").textContent = currentFileName;
  $("#fileDetails").textContent = `${result.timing.samples.toLocaleString()} samples · ${result.timing.duration.toFixed(3)} s · ${result.timing.sampleRate.toFixed(1)} Hz · acc_1G=${result.constants.acc1G.toFixed(1)}`;

  const valid = result.coverage.attitude;
  $("#sustainedSpeed").textContent = valid ? `${formatNumber(result.metrics.sustainedPeakKmh, 1)} km/h` : "نامعتبر";
  $("#sustainedTime").textContent = valid ? `در t = ${formatNumber(result.metrics.sustainedPeakTime, 3)} s` : "سه محور attitude موجود نیست";
  $("#sampleSpeed").textContent = valid ? `${formatNumber(result.metrics.samplePeakKmh, 1)} km/h` : "—";
  $("#sampleTime").textContent = valid ? `در ${formatNumber(result.metrics.samplePeakTime, 3)} s` : "محاسبه متوقف شد";
  $("#horizontalSpeed").textContent = valid ? `${formatNumber(result.metrics.horizontalPeakKmh, 1)} km/h` : "—";
  $("#peakHeight").textContent = result.coverage.barometer ? `${formatNumber(result.metrics.peakHeight, 1)} m` : "بدون بارومتر";
  $("#speedRange").textContent = valid
    ? `حساسیت یک‌سیگما ±${formatNumber(result.uncertainty.sigmaVelocityKmh, 1)} km/h · مونت‌کارلو ${formatNumber(result.uncertainty.monteCarlo.p025, 0)} تا ${formatNumber(result.uncertainty.monteCarlo.p975, 0)}`
    : "برای جلوگیری از خروجی ساختگی، قله سرعت نمایش داده نشد.";
  $("#confidenceBadge").textContent = valid ? "IMU-only · کم‌اعتماد" : "نامعتبر";
  $("#validityText").textContent = `بازه عملکرد تا ${result.validity.performanceEnd.toFixed(3)} s · ${result.validity.performanceEndSource}`;
  $("#wrongSpeed").textContent = `${formatNumber(result.metrics.wrongScalarEndKmh, 1)} km/h`;
  $("#chartEnd").textContent = formatTime(result.validity.performanceEnd);

  renderPipeline();
  renderCalibration();
  renderValidity();
  drawChart();
  requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
}

function renderPipeline() {
  const pipeline = $("#pipeline");
  pipeline.innerHTML = currentResult.stages.map((stage, index) => `
    <button class="stage-card ${stage.state} ${index === selectedStage ? "active" : ""}" data-stage="${index}" type="button">
      <span class="stage-top"><span>${String(index + 1).padStart(2, "0")}</span><i></i></span>
      <b>${escapeHtml(stage.title)}</b>
    </button>
  `).join("");
  $$(".stage-card").forEach((card) => card.addEventListener("click", () => {
    selectedStage = Number(card.dataset.stage);
    renderPipeline();
  }));
  renderStageDetail();
}

function renderStageDetail() {
  const stage = currentResult.stages[selectedStage];
  $("#stageNumber").textContent = String(selectedStage + 1).padStart(2, "0");
  $("#stageTitle").textContent = stage.title;
  $("#stageFormula").textContent = stage.formula;
  $("#stageCode").textContent = stage.code;
  $("#stageReason").textContent = stage.reason;
  $("#stageInput").textContent = stage.input;
  $("#stageOutput").textContent = stage.output;
}

function renderCalibration() {
  const calibration = currentResult.calibration;
  const rows = ["x", "y", "z"].map((axis, index) => `
    <span><b>${axis}</b></span>
    <span>${calibration.biasCounts[index].toFixed(4)}</span>
    <span>${calibration.biasMps2[index].toFixed(5)}</span>
    <span>${calibration.blockStdMps2[index].toFixed(4)}</span>
  `).join("");
  $("#biasTable").innerHTML = `
    <span class="head">AXIS</span><span class="head">BIAS count</span><span class="head">BIAS m/s²</span><span class="head">σ block</span>${rows}
  `;
}

function renderValidity() {
  const result = currentResult;
  const checks = [
    [result.constants.accScaleSource === "Blackbox metadata", "مقیاس شتاب", `${result.constants.acc1G.toFixed(1)} count/g · ${result.constants.accScaleSource}`],
    [result.coverage.attitude, "نگرش سه‌محوره", result.coverage.attitude ? "ماتریس ZYX قابل اجراست" : "خروجی سرعت مسدود شد"],
    [result.timing.invalidDtCount === 0, "پیوستگی زمان", `${result.timing.invalidDtCount} فاصله نامعتبر · حد ${(result.constants.maxGap * 1000).toFixed(2)} ms`],
    [result.coverage.barometer, "قید عمودی", result.coverage.barometer ? `${result.drift.verticalBarometerUpdates.toLocaleString()} update در Kalman` : "کانال عمودی بدون مرجع"],
    [false, "مرجع افقی", "GPS / optical flow / pitot ثبت نشده است"],
  ];
  $("#validityChecks").innerHTML = checks.map(([ok, title, detail]) => `
    <div class="check ${ok ? "" : "warn"}"><i>${ok ? "✓" : "!"}</i><div><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></div></div>
  `).join("");
}

const chartSchemes = {
  speed: [
    { key: "sustained", label: "قله پایدار / سرعت 3D", color: "#147354", factor: 3.6 },
    { key: "horizontal", label: "سرعت افقی", color: "#277bd5", factor: 3.6 },
    { key: "aided", label: "3D با قید عمودی بارومتر", color: "#a06b22", factor: 3.6 },
  ],
  acceleration: [
    { key: "acceleration", label: "|شتاب دینامیکی| m/s²", color: "#147354", factor: 1 },
    { key: "gyro", label: "|gyro| ÷100", color: "#277bd5", factor: .01 },
  ],
  uncertainty: [
    { key: "sustained", label: "سرعت پایدار km/h", color: "#147354", factor: 3.6 },
    { key: "uncertainty", label: "حساسیت یک‌سیگما km/h", color: "#b94c41", factor: 3.6 },
  ],
};

function drawChart() {
  if (!currentResult) return;
  const canvas = $("#chart");
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const pad = { left: 8, right: 10, top: 12, bottom: 12 };
  const points = currentResult.chart;
  const scheme = chartSchemes[chartMode];
  const values = [];
  for (const point of points) for (const series of scheme) {
    const value = point[series.key];
    if (Number.isFinite(value)) values.push(Math.abs(value * series.factor));
  }
  const maximum = Math.max(1, percentileForChart(values, .995) * 1.08);
  const endTime = currentResult.validity.performanceEnd || 1;

  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#dfe7e2";
  context.lineWidth = 1;
  for (let row = 0; row <= 4; row += 1) {
    const y = pad.top + row * (height - pad.top - pad.bottom) / 4;
    context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke();
  }
  for (let column = 0; column <= 6; column += 1) {
    const x = pad.left + column * (width - pad.left - pad.right) / 6;
    context.beginPath(); context.moveTo(x, pad.top); context.lineTo(x, height - pad.bottom); context.stroke();
  }

  for (const series of scheme) {
    context.beginPath();
    let started = false;
    for (const point of points) {
      const value = point[series.key];
      if (!Number.isFinite(value)) continue;
      const x = pad.left + point.t / endTime * (width - pad.left - pad.right);
      const y = height - pad.bottom - Math.min(maximum, Math.abs(value * series.factor)) / maximum * (height - pad.top - pad.bottom);
      if (!started) { context.moveTo(x, y); started = true; } else context.lineTo(x, y);
    }
    context.strokeStyle = series.color;
    context.lineWidth = series.key === "sustained" ? 2.4 : 1.5;
    context.stroke();
  }
  chartGeometry = { width, height, pad, maximum, endTime, points, scheme };
  $("#chartLegend").innerHTML = scheme.map((series) => `<span style="--series:${series.color}">${series.label}</span>`).join("");
}

function percentileForChart(values, probability) {
  if (!values.length) return 1;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability))];
}

function updateTooltip(event) {
  if (!chartGeometry) return;
  const canvas = $("#chart");
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const { pad, endTime, points, scheme } = chartGeometry;
  const time = Math.max(0, Math.min(endTime, (x - pad.left) / (rect.width - pad.left - pad.right) * endTime));
  const index = Math.max(0, Math.min(points.length - 1, Math.round(time / endTime * (points.length - 1))));
  const point = points[index];
  const lines = scheme.map((series) => `${series.label}: ${Number.isFinite(point[series.key]) ? (point[series.key] * series.factor).toFixed(2) : "—"}`);
  const tooltip = $("#chartTooltip");
  tooltip.innerHTML = `<b>t=${point.t.toFixed(3)}s</b><br>${lines.join("<br>")}`;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${event.clientY - rect.top}px`;
  tooltip.classList.remove("hidden");
}

function downloadJson() {
  if (!currentResult) return;
  const blob = new Blob([JSON.stringify({ file: currentFileName, generatedAt: new Date().toISOString(), ...currentResult }, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${currentFileName.replace(/\.[^.]+$/, "")}-flight-vector-v2.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function printReport() {
  if (!currentResult) return;
  const result = currentResult;
  const stages = result.stages.map((stage, index) => `
    <section class="stage"><h3>${index + 1}. ${escapeHtml(stage.title)}</h3><p class="formula" dir="ltr">${escapeHtml(stage.formula)}</p>
    <p><b>دلیل:</b> ${escapeHtml(stage.reason)}</p><p><b>خروجی:</b> ${escapeHtml(stage.output)}</p></section>
  `).join("");
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    alert("مرورگر پنجره گزارش را مسدود کرد. اجازه pop-up را برای localhost فعال کنید.");
    return;
  }
  reportWindow.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>گزارش ${escapeHtml(currentFileName)}</title><style>
    @page{size:A4;margin:16mm}body{font-family:Tahoma,Arial,sans-serif;color:#172720;line-height:1.8;font-size:10pt}header{border-bottom:3px solid #147354;padding-bottom:12px;margin-bottom:18px}h1{font-size:23pt;margin:0;color:#174d3c}h2{font-size:15pt;color:#147354;margin-top:22px}h3{font-size:11pt;margin-bottom:6px}.meta{color:#667670;font-size:9pt;direction:ltr;text-align:right}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.metric{border:1px solid #cedbd4;border-radius:8px;padding:10px}.metric span,.metric b{display:block}.metric span{color:#667670;font-size:8pt}.metric b{direction:ltr;text-align:right;font-size:16pt}.warning{background:#fff3dd;border:1px solid #e3c58e;padding:10px;border-radius:8px}.stage{break-inside:avoid;border-top:1px solid #d9e2dc;padding-top:9px}.formula{direction:ltr;text-align:left;background:#eef5f1;padding:8px;border-right:4px solid #147354;font-family:Consolas,monospace}.table{width:100%;border-collapse:collapse}.table td,.table th{border:1px solid #d5ded9;padding:6px}.table th{background:#e7f1eb}.footer{margin-top:24px;color:#75847e;font-size:8pt;border-top:1px solid #d9e2dc;padding-top:8px}@media print{button{display:none}}</style></head><body>
    <header><p>FLIGHT VECTOR 2 · CALCULATION AUDIT</p><h1>گزارش بازسازی سرعت پهپاد</h1><div class="meta">${escapeHtml(currentFileName)} · ${result.timing.samples.toLocaleString()} samples · ${result.timing.duration.toFixed(3)} s</div></header>
    <h2>نتیجه</h2><div class="metrics">
      <div class="metric"><span>قله پایدار یک‌ثانیه‌ای</span><b>${formatNumber(result.metrics.sustainedPeakKmh, 1)} km/h</b></div>
      <div class="metric"><span>قله نمونه‌ای IMU</span><b>${formatNumber(result.metrics.samplePeakKmh, 1)} km/h</b></div>
      <div class="metric"><span>حساسیت یک‌سیگما</span><b>±${formatNumber(result.uncertainty.sigmaVelocityKmh, 1)} km/h</b></div>
    </div>
    <p class="warning"><b>حد ادعا:</b> ${escapeHtml(result.uncertainty.confidence)}. سرعت افقی مرجع مستقلی ندارد و نتیجه اندازه‌گیری GPS نیست.</p>
    <h2>ثابت‌ها و کالیبراسیون</h2><table class="table"><tr><th>پارامتر</th><th>مقدار</th></tr>
      <tr><td>acc_1G</td><td dir="ltr">${result.constants.acc1G.toFixed(3)} count/g · ${escapeHtml(result.constants.accScaleSource)}</td></tr>
      <tr><td>بایاس بدنه</td><td dir="ltr">[${result.calibration.biasCounts.map((value) => value.toFixed(4)).join(", ")}] count</td></tr>
      <tr><td>بازه عملکرد</td><td dir="ltr">0 … ${result.validity.performanceEnd.toFixed(3)} s · ${escapeHtml(result.validity.performanceEndSource)}</td></tr>
      <tr><td>فیلتر اضافه</td><td dir="ltr">${result.filter.lowPassHz ? `${result.filter.lowPassHz} Hz` : "none; accSmooth used directly"}</td></tr>
      <tr><td>خروجی فرمول قدیمی</td><td dir="ltr">${result.metrics.wrongScalarEndKmh.toFixed(1)} km/h</td></tr></table>
    <h2>زنجیره محاسبه</h2>${stages}
    <h2>عدم‌قطعیت</h2><p dir="ltr" class="formula">σv² ≈ σv0² + (tσba)² + (gtσθ)²</p>
    <p>مدل مونت‌کارلو با ${result.uncertainty.monteCarlo.samples} نمونه، بازه حساسیت ${formatNumber(result.uncertainty.monteCarlo.p025, 1)} تا ${formatNumber(result.uncertainty.monteCarlo.p975, 1)} کیلومتر بر ساعت را داد. این بازه فاصله اطمینان تجربی نیست.</p>
    <p class="footer">گزارش به‌صورت محلی توسط Flight Vector 2 ساخته شد. برای ذخیره PDF در پنجره چاپ، گزینه Save as PDF را انتخاب کنید.</p>
    <script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`);
  reportWindow.document.close();
}

function resetApp() {
  if (currentWorker) currentWorker.terminate();
  currentWorker = null;
  currentResult = null;
  currentBuffer = null;
  currentFileName = "";
  selectedStage = 0;
  workspace.classList.add("hidden");
  landing.classList.remove("hidden");
  $("#newButton").disabled = true;
  fileInput.value = "";
  clearNotice();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function buildDemoCsv() {
  const lines = [
    '"Product","Flight Vector 2 defendable demo"',
    '"firmwareVersion","4.5.3"',
    '"acc_1G",2048',
    '"loopIteration","time","gyroADC[0]","gyroADC[1]","gyroADC[2]","accSmooth[0]","accSmooth[1]","accSmooth[2]","heading[0]","heading[1]","heading[2]","setpoint[0]","setpoint[1]","setpoint[2]","rcCommand[3]","baroAlt"',
  ];
  const dt = .002;
  let altitude = 0;
  for (let i = 0; i <= 15000; i += 1) {
    const t = i * dt;
    const airborne = t > 3;
    const roll = airborne ? 0.08 * Math.sin(t * .8) : 0;
    const pitch = airborne ? -0.14 * Math.sin((t - 3) * .35) : 0;
    const yaw = airborne ? (t - 3) * .08 : 0;
    const forward = airborne && t < 17 ? 2.2 * Math.sin(Math.min(Math.PI, (t - 3) / 14 * Math.PI)) : airborne ? -1.1 * Math.exp(-(t - 17) / 5) : 0;
    const vertical = airborne && t < 10 ? .8 : airborne && t > 22 ? -.7 : 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const nav = [forward, 0, 9.80665 + vertical];
    const bx = cy * cp * nav[0] + sy * cp * nav[1] - sp * nav[2];
    const by = (cy * sp * sr - sy * cr) * nav[0] + (sy * sp * sr + cy * cr) * nav[1] + cp * sr * nav[2];
    const bz = (cy * sp * cr + sy * sr) * nav[0] + (sy * sp * cr - cy * sr) * nav[1] + cp * cr * nav[2];
    const noise = () => (Math.random() - .5) * 7;
    const gx = airborne ? 4 * Math.cos(t * .8) : 0;
    const gy = airborne ? -2.8 * Math.cos((t - 3) * .35) : 0;
    const gz = airborne ? 4.6 : 0;
    altitude += vertical * dt;
    lines.push([
      i, Math.round(t * 1e6), gx.toFixed(3), gy.toFixed(3), gz.toFixed(3),
      (bx / 9.80665 * 2048 + 4 + noise()).toFixed(3),
      (by / 9.80665 * 2048 - 3 + noise()).toFixed(3),
      (bz / 9.80665 * 2048 + 5 + noise()).toFixed(3),
      roll.toFixed(7), pitch.toFixed(7), yaw.toFixed(7), gx.toFixed(3), gy.toFixed(3), gz.toFixed(3),
      airborne ? 1450 : 1000, Math.round(altitude * 100 + (Math.random() - .5) * 20),
    ].join(","));
  }
  return new TextEncoder().encode(lines.join("\n")).buffer;
}

fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault(); dropzone.classList.add("drag");
}));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault(); dropzone.classList.remove("drag");
  if (name === "drop" && event.dataTransfer.files[0]) loadFile(event.dataTransfer.files[0]);
}));
$("#demoButton").addEventListener("click", () => {
  currentFileName = "defendable-demo.csv";
  currentBuffer = buildDemoCsv();
  analyzeBuffer();
});
$("#newButton").addEventListener("click", resetApp);
$("#jsonButton").addEventListener("click", downloadJson);
$("#reportButton").addEventListener("click", printReport);
$("#settingsButton").addEventListener("click", () => settingsDialog.showModal());
$("#recalculateButton").addEventListener("click", (event) => {
  event.preventDefault(); settingsDialog.close(); analyzeBuffer();
});
$("#chartTabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  chartMode = button.dataset.mode;
  $$("#chartTabs button").forEach((item) => item.classList.toggle("active", item === button));
  drawChart();
});
$("#chart").addEventListener("mousemove", updateTooltip);
$("#chart").addEventListener("mouseleave", () => $("#chartTooltip").classList.add("hidden"));
window.addEventListener("resize", () => currentResult && drawChart());
