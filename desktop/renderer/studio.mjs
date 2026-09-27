const bridge = window.liveTalkingDesktop;
if (bridge?.version) {
  document.querySelector('#app-version').textContent = `v0.1 · API ${bridge.version}`;
}
