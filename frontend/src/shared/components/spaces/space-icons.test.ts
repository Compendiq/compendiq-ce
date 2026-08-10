import { describe, it, expect } from 'vitest';
import { HardDrive } from 'lucide-react';
import { SPACE_ICONS, getSpaceIcon } from './space-icons';

describe('getSpaceIcon', () => {
  it('resolves every catalogued value to its own glyph', () => {
    for (const { value, Icon } of SPACE_ICONS) {
      expect(getSpaceIcon(value), `value "${value}"`).toBe(Icon);
    }
  });

  it('falls back to HardDrive for unset AND unrecognised values', () => {
    // spaces.icon is free text (z.string().max(100)), so an unrecognised
    // string must take the same fallback as null — not throw, not render
    // nothing.
    expect(getSpaceIcon(null)).toBe(HardDrive);
    expect(getSpaceIcon(undefined)).toBe(HardDrive);
    expect(getSpaceIcon('')).toBe(HardDrive);
    expect(getSpaceIcon('folder')).toBe(HardDrive);
    expect(getSpaceIcon('folder')).toBe(getSpaceIcon(null));
  });

  it('never catalogues HardDrive as a pickable value', () => {
    // HardDrive is the fallback mark; if it joined the catalogue, "chose the
    // generic icon" and "never chose one" would become indistinguishable.
    expect(SPACE_ICONS.some(({ Icon }) => Icon === HardDrive)).toBe(false);
  });
});
