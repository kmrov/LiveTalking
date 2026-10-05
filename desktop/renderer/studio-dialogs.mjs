// Native dialogs provide focus containment, Escape and focus restoration.
export function mountStudioDialogs({ document, onSettingsOpen, onSettingsClose }) {
  const settings = document.querySelector('#profile-settings-dialog');
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  let saved = false;
  let busy = false;

  function selectTab(name, focus = false) {
    document.querySelector('#setup-details').scrollTop = 0;
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }

  function openSettings(name = 'voice') {
    if (!settings.open) {
      saved = false;
      onSettingsOpen?.();
      selectTab(name);
      settings.showModal();
    }
    selectTab(name, true);
  }

  for (const button of document.querySelectorAll('[data-open-settings]')) {
    button.addEventListener('click', () => openSettings(button.dataset.openSettings));
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.settingsTab));
    tab.addEventListener('keydown', event => {
      const direction = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      let index = direction ? (tabs.indexOf(tab) + direction + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (index < 0) return;
      event.preventDefault();
      selectTab(tabs[index].dataset.settingsTab, true);
    });
  }
  settings.addEventListener('close', () => onSettingsClose?.({ saved }));
  settings.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  settings.addEventListener('invalid', event => {
    const panel = event.target.closest('[role="tabpanel"]');
    if (panel) selectTab(panel.id.replace('settings-', ''));
  }, true);
  for (const button of document.querySelectorAll('[data-open-dialog]')) {
    button.addEventListener('click', () => document.getElementById(button.dataset.openDialog).showModal());
  }
  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  return {
    openSettings,
    selectTab,
    setBusy(value) {
      busy = value;
      settings.setAttribute('aria-busy', String(value));
      document.querySelector('#setup-details').inert = value;
      for (const button of settings.querySelectorAll('[data-close-dialog], #save-profile, #check-setup')) button.disabled = value;
    },
    closeSettings() { saved = true; settings.close(); },
  };
}
