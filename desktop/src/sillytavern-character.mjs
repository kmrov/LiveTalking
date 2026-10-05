export const DEFAULT_SILLYTAVERN_CHARACTER = 'Viktor_Petrovich_Studio.png';

export function sillyTavernCharacter(value = DEFAULT_SILLYTAVERN_CHARACTER) {
  if (typeof value !== 'string' || value.length < 5 || value.length > 255 || !value.toLowerCase().endsWith('.png')
    || /[/\\\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid SillyTavern character filename');
  return value;
}
