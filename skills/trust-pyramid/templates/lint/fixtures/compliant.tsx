declare const t: (key: string) => string;

export function Compliant({ release }: { release: () => void }) {
  setTimeout(() => release(), 500);
  return <div>
    <button title={t('Delete note')}>{t('Save settings')}</button>
    <span lang="zh-CN">中文</span>
  </div>;
}
