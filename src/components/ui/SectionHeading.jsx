import React from 'react';

export default function SectionHeading({ index, title, description, action, className = '' }) {
  return (
    <header className={`section-heading ${className}`.trim()}>
      <div className="section-heading-copy">
        <span className="section-heading-index" aria-hidden="true">
          {index}
        </span>
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      {action ? <div className="section-heading-action">{action}</div> : null}
    </header>
  );
}
