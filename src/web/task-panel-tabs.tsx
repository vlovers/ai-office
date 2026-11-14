export type TaskPanel = 'details' | 'new';

export function TaskPanelTabs({
  active,
  onChange,
}: {
  active: TaskPanel;
  onChange: (panel: TaskPanel) => void;
}) {
  return (
    <div className="task-panel-tabs" role="group" aria-label="Task workspace view">
      <button
        type="button"
        className={active === 'details' ? 'active' : ''}
        aria-pressed={active === 'details'}
        onClick={() => onChange('details')}
      >
        Task details
      </button>
      <button
        type="button"
        className={active === 'new' ? 'active' : ''}
        aria-pressed={active === 'new'}
        onClick={() => onChange('new')}
      >
        + New task
      </button>
    </div>
  );
}
