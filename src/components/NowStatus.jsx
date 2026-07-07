import React, { useEffect, useMemo, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { apiUrl } from '../api/client';

const DEFAULT_STATUS = {
  mood: '感觉不错',
  reading: '《人类简史》',
};

const DEFAULT_WEATHER = {
  temp: '--',
  condition: '加载中',
  icon: '🌤',
};

export default function NowStatus({ isAdmin, adminToken }) {
  const [weather, setWeather] = useState(DEFAULT_WEATHER);
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [editingField, setEditingField] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      try {
        const [weatherRes, statusRes] = await Promise.all([
          fetch(apiUrl('/api/weather')),
          fetch(apiUrl('/api/status')),
        ]);

        if (weatherRes.ok) {
          const weatherData = await weatherRes.json();
          if (!cancelled) {
            setWeather({
              temp: weatherData?.temp || '--',
              condition: weatherData?.condition || '未知',
              icon: weatherData?.icon || '🌤',
            });
          }
        }

        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (!cancelled) {
            setStatus({
              mood: statusData?.mood || DEFAULT_STATUS.mood,
              reading: statusData?.reading || DEFAULT_STATUS.reading,
            });
          }
        }
      } catch {
      }
    };

    loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(
    () => [
      {
        key: 'weather',
        icon: weather.icon || '🌤',
        text: `${weather.temp || '--'}  成都 · ${weather.condition || '未知'}`,
        editable: false,
      },
      {
        key: 'mood',
        icon: '💭',
        text: status.mood || DEFAULT_STATUS.mood,
        editable: true,
      },
      {
        key: 'reading',
        icon: '📖',
        text: status.reading || DEFAULT_STATUS.reading,
        editable: true,
      },
    ],
    [status, weather]
  );

  const startEdit = (field) => {
    setEditingField(field);
    setDraftValue(status[field] || '');
  };

  const saveField = async (field) => {
    if (!adminToken || saving) return;

    const trimmed = draftValue.trim();
    if (!trimmed) return;

    setSaving(true);
    try {
      const payload = {
        adminToken,
        [field]: trimmed,
      };
      const response = await fetch(apiUrl('/api/status'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const data = await response.json();
      setStatus({
        mood: data?.mood || DEFAULT_STATUS.mood,
        reading: data?.reading || DEFAULT_STATUS.reading,
      });
      setEditingField('');
      setDraftValue('');
    } catch {
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="now-status" aria-label="此刻状态">
      {rows.map((row) => {
        const isEditing = editingField === row.key;

        return (
          <div key={row.key} className="now-status-row">
            <span>{row.icon}</span>
            {isEditing ? (
              <>
                <input
                  className="now-status-input"
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  disabled={saving}
                  autoFocus
                />
                <button
                  type="button"
                  className="now-status-edit-btn"
                  onClick={() => saveField(row.key)}
                  disabled={saving || !draftValue.trim()}
                  aria-label={`保存${row.key === 'mood' ? '心情' : '最近在看'}`}
                >
                  <Check size={14} />
                </button>
              </>
            ) : (
              <>
                <span className="now-status-text">{row.text}</span>
                {isAdmin && row.editable ? (
                  <button
                    type="button"
                    className="now-status-edit-btn"
                    onClick={() => startEdit(row.key)}
                    aria-label={`编辑${row.key === 'mood' ? '心情' : '最近在看'}`}
                  >
                    <Pencil size={13} />
                  </button>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
