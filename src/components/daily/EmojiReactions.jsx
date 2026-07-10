import React, { useEffect, useState } from 'react';
import { apiUrl } from '../../api/client';
import { useDialog } from '../../context/DialogContext';

const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '🤔'];

function createEmptyCounts() {
  return Object.fromEntries(REACTION_EMOJIS.map((emoji) => [emoji, 0]));
}

function storageKey(diaryId) {
  return `reaction_${diaryId}`;
}

function readReactedEmojis(diaryId) {
  if (typeof window === 'undefined') {
    return new Set();
  }

  try {
    const stored = window.localStorage.getItem(storageKey(diaryId));
    const parsed = JSON.parse(stored || '[]');
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((emoji) => REACTION_EMOJIS.includes(emoji)));
  } catch {
    return new Set();
  }
}

function persistReactedEmojis(diaryId, reactedSet) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(storageKey(diaryId), JSON.stringify(Array.from(reactedSet)));
}

export default function EmojiReactions({ diaryId }) {
  const { toast } = useDialog();
  const [counts, setCounts] = useState(() => createEmptyCounts());
  const [reacted, setReacted] = useState(() => readReactedEmojis(diaryId));
  const [pendingEmoji, setPendingEmoji] = useState('');

  useEffect(() => {
    let cancelled = false;

    const loadCounts = async () => {
      try {
        const response = await fetch(apiUrl(`/api/reactions?diaryId=${encodeURIComponent(diaryId)}`));
        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`);
        }

        const data = await response.json();
        if (!cancelled) {
          setCounts({ ...createEmptyCounts(), ...data });
        }
      } catch {
        if (!cancelled) {
          setCounts(createEmptyCounts());
        }
      }
    };

    loadCounts();

    return () => {
      cancelled = true;
    };
  }, [diaryId]);

  const handleToggle = async (emoji) => {
    if (!diaryId || pendingEmoji) {
      return;
    }

    const hadReacted = reacted.has(emoji);
    const nextAction = hadReacted ? 'remove' : 'add';
    const previousCounts = counts;
    const previousReacted = reacted;
    const nextReacted = new Set(previousReacted);

    if (hadReacted) {
      nextReacted.delete(emoji);
    } else {
      nextReacted.add(emoji);
    }

    const nextCounts = {
      ...previousCounts,
      [emoji]: Math.max((previousCounts[emoji] || 0) + (hadReacted ? -1 : 1), 0),
    };

    setPendingEmoji(emoji);
    setCounts(nextCounts);
    setReacted(nextReacted);
    persistReactedEmojis(diaryId, nextReacted);

    try {
      const response = await fetch(apiUrl('/api/reactions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diaryId, emoji, action: nextAction }),
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const data = await response.json();
      setCounts({ ...createEmptyCounts(), ...data });
    } catch {
      setCounts(previousCounts);
      setReacted(previousReacted);
      persistReactedEmojis(diaryId, previousReacted);
      toast.error('操作失败，请重试');
    } finally {
      setPendingEmoji('');
    }
  };

  return (
    <div className="emoji-reactions" aria-label="日记表情反馈">
      {REACTION_EMOJIS.map((emoji) => {
        const isReacted = reacted.has(emoji);

        return (
          <button
            key={emoji}
            type="button"
            className={`emoji-btn ${isReacted ? 'reacted' : ''}`}
            onClick={() => handleToggle(emoji)}
            aria-pressed={isReacted}
            disabled={Boolean(pendingEmoji)}
            title={isReacted ? '取消反应' : '添加反应'}
          >
            <span>{emoji}</span>
            <span className="reaction-count">{counts[emoji] || 0}</span>
          </button>
        );
      })}
    </div>
  );
}
