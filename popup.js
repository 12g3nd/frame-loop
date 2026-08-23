const store = chrome.storage.local;
const toggle = document.getElementById("toggle");
const fpsIn = document.getElementById("fps");
const autoBtn = document.getElementById("auto");

function render(hidden, fps) {
  toggle.textContent = hidden ? "Show" : "Hide";
  toggle.classList.toggle("on", hidden);
  const manual = fps != null && fps !== "";
  autoBtn.classList.toggle("on", !manual);
  autoBtn.textContent = manual ? "Manual" : "Auto";
  if (document.activeElement !== fpsIn) fpsIn.value = manual ? fps : "";
}

store.get(["fl_hidden", "fl_fps"], (d) => render(!!(d && d.fl_hidden), d ? d.fl_fps : null));

toggle.onclick = () => {
  store.get(["fl_hidden"], (d) => {
    const next = !(d && d.fl_hidden);
    store.set({ fl_hidden: next });
    store.get(["fl_fps"], (e) => render(next, e ? e.fl_fps : null));
  });
};

fpsIn.onchange = () => {
  const v = parseFloat(fpsIn.value);
  const val = v > 0 ? v : null;
  store.set({ fl_fps: val });
  store.get(["fl_hidden"], (d) => render(!!(d && d.fl_hidden), val));
};

autoBtn.onclick = () => {
  store.get(["fl_fps"], (d) => {
    const manual = d && d.fl_fps != null;
    const val = manual ? null : parseFloat(fpsIn.value) || 30;
    store.set({ fl_fps: val });
    store.get(["fl_hidden"], (e) => render(!!(e && e.fl_hidden), val));
  });
};
