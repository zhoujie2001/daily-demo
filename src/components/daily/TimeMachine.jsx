import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  Clock3,
  Home,
  Link2,
  RotateCw,
} from 'lucide-react';
import { TIME_MACHINE_STRATEGIES } from '../../utils/timeMachine';

export function TimeMachineControls({ disabled, isTraveling, onTravel }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState('surprise');
  const controlRef = useRef(null);
  const selected = TIME_MACHINE_STRATEGIES.find((strategy) => strategy.id === selectedStrategy) || TIME_MACHINE_STRATEGIES[0];

  useEffect(() => {
    if (!menuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!controlRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const travel = (strategy) => {
    setSelectedStrategy(strategy);
    setMenuOpen(false);
    onTravel(strategy);
  };

  return (
    <div className="time-machine-control" ref={controlRef}>
      <div className="time-machine-button-group">
        <button
          type="button"
          className="time-machine-trigger"
          disabled={disabled || isTraveling}
          onClick={() => travel(selected.id)}
          title={`前往：${selected.label}`}
        >
          <Clock3 size={16} aria-hidden="true" />
          <span className="time-machine-label-full">{isTraveling ? '穿越中…' : '随机时光机'}</span>
          <span className="time-machine-label-short">{isTraveling ? '穿越中…' : '时光机'}</span>
        </button>
        <button
          type="button"
          className="time-machine-menu-toggle"
          aria-label="选择随机时光机目的地"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled || isTraveling}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>

      {menuOpen ? (
        <div className="time-machine-menu" role="menu" aria-label="随机目的地">
          <div className="time-machine-menu-heading">选择一段时间</div>
          {TIME_MACHINE_STRATEGIES.map((strategy) => (
            <button
              key={strategy.id}
              type="button"
              role="menuitemradio"
              aria-checked={strategy.id === selectedStrategy}
              className={`time-machine-option ${strategy.id === selectedStrategy ? 'active' : ''}`}
              onClick={() => travel(strategy.id)}
            >
              <span className="time-machine-option-dot" aria-hidden="true" />
              <span>
                <strong>{strategy.label}</strong>
                <small>{strategy.description}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TimeTravelOverlay({ date, message }) {
  return (
    <div className="time-travel-overlay" role="status" aria-live="assertive" aria-label="正在随机选择过去的日记">
      <div className="time-travel-portal" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="time-travel-content">
        <CalendarClock size={24} aria-hidden="true" />
        <p>{message}</p>
        <strong key={date} className="time-travel-date">{date || '···'}</strong>
        <div className="time-travel-track" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  );
}

function getDistanceLabel(daysAgo) {
  if (daysAgo === null || daysAgo === undefined) return '来自过去';
  if (daysAgo === 0) return '就是今天';
  return `${daysAgo.toLocaleString('zh-CN')} 天前`;
}

export function TimeArrival({ arrival, onTravelAgain, onReturnToday, onShare }) {
  const [minimized, setMinimized] = useState(false);
  const arrivalRef = useRef(null);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    const timer = isMobile ? window.setTimeout(() => setMinimized(true), 6000) : null;

    window.requestAnimationFrame(() => arrivalRef.current?.focus({ preventScroll: true }));
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [arrival.post.id]);

  if (minimized) {
    return (
      <button
        type="button"
        className="time-arrival-mini"
        onClick={() => setMinimized(false)}
        aria-label={`展开时光机提示，当前位于${getDistanceLabel(arrival.daysAgo)}`}
      >
        <Clock3 size={15} aria-hidden="true" />
        {getDistanceLabel(arrival.daysAgo)}
      </button>
    );
  }

  return (
    <aside
      ref={arrivalRef}
      className="time-arrival"
      tabIndex={-1}
      aria-live="polite"
      data-source={arrival.source}
    >
      <div className="time-arrival-copy">
        <span className="time-arrival-icon" aria-hidden="true"><Clock3 size={18} /></span>
        <div>
          <strong>
            {arrival.source === 'link' ? '你通过一条时光链接来到了这里' : `你回到了 ${arrival.formattedDate}`}
          </strong>
          <span>{arrival.source === 'link' ? `${arrival.formattedDate} · ${getDistanceLabel(arrival.daysAgo)}` : getDistanceLabel(arrival.daysAgo)}</span>
        </div>
      </div>
      <div className="time-arrival-actions">
        <button type="button" onClick={onTravelAgain}>
          <RotateCw size={14} aria-hidden="true" />
          再去一天
        </button>
        <button type="button" onClick={onReturnToday}>
          <Home size={14} aria-hidden="true" />
          回到今天
        </button>
        <button type="button" onClick={onShare}>
          <Link2 size={14} aria-hidden="true" />
          复制时光链接
        </button>
      </div>
    </aside>
  );
}
