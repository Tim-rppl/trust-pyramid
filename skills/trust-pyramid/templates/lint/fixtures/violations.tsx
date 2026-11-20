export function Violations({ release }: { release: () => void }) {
  setTimeout(() => release(), 0);
  requestAnimationFrame(release);
  return <button title="Delete note">Save settings</button>;
}
