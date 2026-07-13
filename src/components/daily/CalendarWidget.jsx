import React, { useEffect, useMemo, useRef, useState } from 'react';

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parsePostDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDayKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isSameDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function buildMonthDays(monthDate) {
  const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

export default function CalendarWidget({ posts = [], onSelect }) {
  const containerRef = useRef(null);
  const today = useMemo(() => new Date(), []);
  const todayMonthStart = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1), [today]);
  const [visibleMonth, setVisibleMonth] = useState(todayMonthStart);
  const [expanded, setExpanded] = useState(false);

  const postDateMap = useMemo(() => {
    const map = new Map();
    posts.forEach((post) => {
      const parsed = parsePostDate(post.date);
      if (!parsed) return;
      map.set(formatDayKey(parsed), post.id);
    });
    return map;
  }, [posts]);

  const monthDays = useMemo(() => buildMonthDays(visibleMonth), [visibleMonth]);
  const todayLabel = useMemo(
    () =>
      today.toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
      }),
    [today]
  );
  const monthLabel = useMemo(
    () =>
      visibleMonth.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      }),
    [visibleMonth]
  );

  useEffect(() => {
    if (!expanded) return undefined;

    const handlePointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [expanded]);

  const openCalendar = () => setExpanded(true);
  const closeCalendar = () => setExpanded(false);

  const handleDaySelect = (date) => {
    const postId = postDateMap.get(formatDayKey(date));
    if (!postId) return;
    onSelect(postId);
    closeCalendar();
  };

  return (
    <aside className="col-calendar-widget" aria-label="Daily calendar sidebar">
      <div
        ref={containerRef}
        className={`cal-widget-shell ${expanded ? 'is-open' : ''}`}
        onMouseEnter={openCalendar}
        onMouseLeave={closeCalendar}
      >
        <button
          type="button"
          className="cal-widget-trigger"
          onClick={() => setExpanded((current) => !current)}
          aria-haspopup="dialog"
          aria-expanded={expanded}
        >
          <span className="cal-widget-trigger-icon" aria-hidden="true">
            📅
          </span>
          <span className="cal-widget-trigger-content">
            <span className="cal-widget-trigger-label">Today</span>
            <span className="cal-widget-trigger-date">{todayLabel}</span>
          </span>
        </button>

        <div className={`cal-widget-popover ${expanded ? 'is-open' : ''}`} role="dialog" aria-hidden={!expanded}>
          <div className="cal-widget-header">
            <button
              type="button"
              className="cal-widget-nav"
              aria-label="Previous month"
              onClick={() => setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
            >
              ‹
            </button>
            <div className="cal-widget-title">{monthLabel}</div>
            <button
              type="button"
              className="cal-widget-nav"
              aria-label="Next month"
              onClick={() => setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
            >
              ›
            </button>
          </div>

          <div className="cal-widget-weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label} className="cal-widget-weekday">
                {label}
              </span>
            ))}
          </div>

          <div className="cal-widget-grid">
            {monthDays.map((date) => {
              const dayKey = formatDayKey(date);
              const hasPost = postDateMap.has(dayKey);
              const outsideMonth = date.getMonth() !== visibleMonth.getMonth();
              const isToday = isSameDay(date, today);

              return (
                <button
                  key={dayKey}
                  type="button"
                  className={[
                    'cal-widget-day',
                    outsideMonth ? 'is-outside' : '',
                    hasPost ? 'has-post' : '',
                    isToday ? 'is-today' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => handleDaySelect(date)}
                  disabled={!hasPost}
                  aria-label={date.toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                >
                  <span className="cal-widget-day-number">{date.getDate()}</span>
                  <span className="cal-widget-day-dot" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
