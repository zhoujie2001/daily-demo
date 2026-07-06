import React from 'react';

export default function EmptyState({ title = 'Nothing here yet', description, action }) {
  return (
    <div className="ui-empty">
      <div className="ui-empty-title">{title}</div>
      {description && <div className="ui-empty-desc">{description}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
