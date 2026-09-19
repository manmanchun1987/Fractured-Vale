window.FVJoystick = (function () {
  function create(zoneEl) {
    const state = { dx: 0, dy: 0, active: false, id: null };
    const base = document.createElement("div");
    const knob = document.createElement("div");
    Object.assign(base.style, {
      position: "absolute", left: "12px", bottom: "12px",
      width: "110px", height: "110px", borderRadius: "50%",
      background: "rgba(255,255,255,0.12)", border: "2px solid rgba(255,255,255,0.25)",
      touchAction: "none",
      pointerEvents: "auto",
    });
    Object.assign(knob.style, {
      position: "absolute", left: "35px", top: "35px",
      width: "40px", height: "40px", borderRadius: "50%",
      background: "rgba(255,255,255,0.45)", touchAction: "none",
    });
    base.appendChild(knob);
    zoneEl.appendChild(base);

    const maxR = 35;
    const center = { x: 55, y: 55 };

    function setKnob(dx, dy) {
      knob.style.left = `${center.x + dx * maxR - 20}px`;
      knob.style.top = `${center.y + dy * maxR - 20}px`;
    }

    function onStart(x, y, id) {
      state.active = true;
      state.id = id;
      onMove(x, y);
    }
    function onMove(x, y) {
      if (!state.active) return;
      const rect = base.getBoundingClientRect();
      let dx = (x - (rect.left + rect.width / 2)) / maxR;
      let dy = (y - (rect.top + rect.height / 2)) / maxR;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      // deadzone
      if (len < 0.12) { dx = 0; dy = 0; }
      state.dx = dx;
      state.dy = dy;
      setKnob(dx, dy);
    }
    function onEnd() {
      state.active = false;
      state.id = null;
      state.dx = 0;
      state.dy = 0;
      setKnob(0, 0);
    }

    base.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      base.setPointerCapture(e.pointerId);
      onStart(e.clientX, e.clientY, e.pointerId);
    });
    base.addEventListener("pointermove", (e) => {
      if (e.pointerId !== state.id) return;
      onMove(e.clientX, e.clientY);
    });
    base.addEventListener("pointerup", onEnd);
    base.addEventListener("pointercancel", onEnd);

    return {
      get vector() { return { dx: state.dx, dy: state.dy }; },
      destroy() { base.remove(); },
    };
  }
  return { create };
})();
