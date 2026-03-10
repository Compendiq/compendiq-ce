import { useUiStore } from '../../stores/ui-store';

/**
 * Aurora Background - Three slowly drifting radial gradient blobs that replace
 * the static mesh-gradient. Uses GPU-composited properties only (transform, opacity).
 *
 * Respects both the OS-level prefers-reduced-motion and the manual
 * "Reduce Effects" toggle in ui-store. When effects are reduced, renders a
 * static fallback using the existing mesh-gradient CSS utility.
 */
export function AuroraBackground() {
  const reduceEffects = useUiStore((s) => s.reduceEffects);

  if (reduceEffects) {
    return (
      <div
        data-testid="aurora-background"
        className="mesh-gradient pointer-events-none fixed inset-0 -z-10"
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      data-testid="aurora-background"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {/* Indigo blob */}
      <div className="aurora-blob aurora-blob-indigo" />
      {/* Cyan blob */}
      <div className="aurora-blob aurora-blob-cyan" />
      {/* Rose blob */}
      <div className="aurora-blob aurora-blob-rose" />
      {/* Base background color fill */}
      <div className="absolute inset-0 -z-10 bg-background" />
    </div>
  );
}
