export function initialServiceState() {
  return { phase: 'not-configured', profileId: null, detail: '' };
}

export function transitionServiceState(state, event) {
  if (event.type === 'PROFILE_CHANGE') return { phase: 'not-configured', profileId: event.profileId, detail: '' };
  if (event.type === 'STOP') return { phase: 'not-configured', profileId: state.profileId, detail: '' };
  if (event.profileId && state.profileId && event.profileId !== state.profileId && !['CHECK', 'RETRY'].includes(event.type)) return state;
  switch (event.type) {
    case 'CHECK':
    case 'RETRY': return { phase: 'checking', profileId: event.profileId, detail: '' };
    case 'START':
      if (['starting', 'ready'].includes(state.phase) && state.profileId === event.profileId) return state;
      return { phase: 'starting', profileId: event.profileId, detail: '' };
    case 'READY': return { phase: 'ready', profileId: state.profileId || event.profileId, detail: '' };
    case 'RECONNECT': return { ...state, phase: 'reconnecting' };
    case 'FAIL':
    case 'CHILD_EXIT': return { ...state, phase: 'failed', detail: event.detail || 'Service failed' };
    default: return state;
  }
}
