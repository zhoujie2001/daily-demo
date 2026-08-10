import React from 'react';
import { TimeMachineControls } from './TimeMachine';
import DriftBottleControl from './drift/DriftBottleControl';

export default function MemoryActions({
  disabled,
  isTraveling,
  onTimeTravel,
  posts,
  currentPostId,
}) {
  return (
    <div className="memory-actions" aria-label="记忆探索" data-pet-avoid>
      <TimeMachineControls
        disabled={disabled}
        isTraveling={isTraveling}
        onTravel={onTimeTravel}
      />
      <DriftBottleControl
        disabled={disabled}
        posts={posts}
        currentPostId={currentPostId}
      />
    </div>
  );
}
