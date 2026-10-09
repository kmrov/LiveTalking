// Hidden controls keep their text for a later mode switch, but only active settings
// should be submitted or validated when saving the current mode.
export function activeProfileDraft(saved, draft) {
  const external = draft.speech.mode === 'external';
  const persona = draft.brain.mode === 'persona';
  const sillytavern = draft.brain.mode === 'sillytavern';
  const managedPersona = persona && draft.brain.managed;
  return {
    ...draft,
    speech: {
      ...draft.speech,
      ...(external ? {
        asrVllm: saved.speech.asrVllm, ttsVllm: saved.speech.ttsVllm, omniPython: saved.speech.omniPython,
      } : {
        asrUrl: saved.speech.asrUrl, ttsUrl: saved.speech.ttsUrl,
        ...(draft.speech.ttsEngine === 'omnivoice' ? { ttsVllm: saved.speech.ttsVllm } : { omniPython: saved.speech.omniPython }),
      }),
    },
    brain: {
      ...draft.brain,
      ...(!persona ? { managed: saved.brain.managed, url: saved.brain.url } : {}),
      ...(!managedPersona ? {
        root: saved.brain.root, python: saved.brain.python, databaseMode: saved.brain.databaseMode,
      } : {}),
      ...(!sillytavern ? {
        sillyTavernRoot: saved.brain.sillyTavernRoot, sillyTavernUrl: saved.brain.sillyTavernUrl,
      } : {}),
      ...(!sillytavern && !managedPersona ? { folderId: saved.brain.folderId } : {}),
    },
  };
}

export function activeSecretDraft(profile, input) {
  const managedPersona = profile.brain.mode === 'persona' && profile.brain.managed;
  return {
    apiKey: managedPersona || profile.brain.mode === 'sillytavern' ? input.apiKey : '',
    databaseUrl: managedPersona ? input.databaseUrl : '',
  };
}
