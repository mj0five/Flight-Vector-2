importScripts("engine.js");

self.onmessage = ({ data }) => {
  try {
    const bytes = new Uint8Array(data.buffer);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      throw new Error("این فایل ZIP/XLSX است. از Excel خروجی CSV UTF-8 بگیرید.");
    }
    const text = new TextDecoder("utf-8").decode(data.buffer);
    const result = self.FlightVectorEngine.analyzeCsvText(text, data.settings, (update) => {
      self.postMessage({ type: "progress", update });
    });
    self.postMessage({ type: "done", result });
  } catch (error) {
    self.postMessage({ type: "error", message: error && error.message ? error.message : String(error) });
  }
};
