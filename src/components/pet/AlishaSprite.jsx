import React from 'react';

function activateWithKeyboard(handler) {
  return (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handler?.(event);
  };
}

/**
 * 阿丽莎的矢量分层角色。
 *
 * 每个可活动部位都是真实独立的 SVG 图层，不再复制整张位图后裁切。
 * 这样眨眼、耳动、尾摆和抬爪时不会产生重影或接缝。
 */
export default function AlishaSprite({
  interactive = true,
  hasBow = false,
  hasStar = false,
  onBodyClick,
  onHeadClick,
  onHeadPointerDown,
  onHeadPointerMove,
  onHeadPointerUp,
  onLeftEarClick,
  onRightEarClick,
  onTailClick,
}) {
  const hitProps = (label, handler) => (
    interactive
      ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': label,
        onClick: handler,
        onKeyDown: activateWithKeyboard(handler),
      }
      : { 'aria-hidden': true }
  );

  return (
    <svg
      className="alisha-sprite"
      viewBox="0 0 300 300"
      aria-hidden={interactive ? undefined : true}
      aria-label={interactive ? '银灰长毛猫阿丽莎' : undefined}
      focusable={interactive ? undefined : 'false'}
    >
      <defs>
        <linearGradient id="alisha-body-fur" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6f3ed" />
          <stop offset="0.38" stopColor="#d9d9d5" />
          <stop offset="0.7" stopColor="#b7b9b8" />
          <stop offset="1" stopColor="#8f9394" />
        </linearGradient>
        <linearGradient id="alisha-head-fur" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#f7f4ee" />
          <stop offset="0.45" stopColor="#d8d8d3" />
          <stop offset="1" stopColor="#a5a8a7" />
        </linearGradient>
        <linearGradient id="alisha-chest-fur" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#fffdf8" />
          <stop offset="0.72" stopColor="#eeeae2" />
          <stop offset="1" stopColor="#d9d4ca" />
        </linearGradient>
        <linearGradient id="alisha-tail-fur" x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0" stopColor="#a5a9aa" />
          <stop offset="0.42" stopColor="#d7d7d2" />
          <stop offset="0.82" stopColor="#f3f0ea" />
          <stop offset="1" stopColor="#bfc1bf" />
        </linearGradient>
        <radialGradient id="alisha-iris" cx="46%" cy="42%" r="62%">
          <stop offset="0" stopColor="#f6df78" />
          <stop offset="0.55" stopColor="#bda947" />
          <stop offset="1" stopColor="#756e27" />
        </radialGradient>
        <linearGradient id="alisha-ear-inner" x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#e8bebb" />
          <stop offset="1" stopColor="#ba8e8d" />
        </linearGradient>
        <filter id="alisha-soft-shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="#413b35" floodOpacity="0.18" />
        </filter>
        <filter id="alisha-eye-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.2" floodColor="#5a5121" floodOpacity="0.35" />
        </filter>
        <clipPath id="alisha-left-eye-clip">
          <path d="M96 105c8-12 25-14 35-3 4 5 3 14-1 20-9 9-25 8-33-1-4-5-4-11-1-16Z" />
        </clipPath>
        <clipPath id="alisha-right-eye-clip">
          <path d="M166 102c10-10 27-8 34 5 3 6 1 13-4 18-10 7-25 4-31-6-3-6-2-12 1-17Z" />
        </clipPath>
      </defs>

      <ellipse
        className="alisha-shadow"
        cx="157"
        cy="276"
        rx="103"
        ry="13"
        fill="rgba(67,56,46,0.16)"
      />

      <g className="alisha-tail" filter="url(#alisha-soft-shadow)">
        <path
          d="M186 235c26-10 62-16 83-3 22 14 20 38-2 49-25 13-76 10-101-5-13-8-14-22-4-30 6-5 14-8 24-11Z"
          fill="url(#alisha-tail-fur)"
          stroke="#858988"
          strokeWidth="1.4"
        />
        <path
          d="M203 239c22 1 47 1 65 10m-75 2c23 3 47 9 65 20m-72-9c18 6 35 13 49 21"
          fill="none"
          stroke="#878b8b"
          strokeLinecap="round"
          strokeWidth="3.2"
          opacity="0.48"
        />
        <path
          d="M216 235c17 2 32 5 44 11m-53 3c21 6 35 13 46 22"
          fill="none"
          stroke="#f8f4ec"
          strokeLinecap="round"
          strokeWidth="2"
          opacity="0.62"
        />
      </g>

      <g className="alisha-torso" filter="url(#alisha-soft-shadow)">
        <path
          d="M77 178c4-55 36-84 80-84 47 0 81 34 84 91l1 60c-4 28-35 39-84 38-52 0-83-15-86-43l5-62Z"
          fill="url(#alisha-body-fur)"
          stroke="#8b8e8d"
          strokeWidth="1.5"
        />
        <path
          d="M78 177c-12 15-17 39-10 62 5 17 17 28 37 33-12-17-14-39-8-63 4-17 3-28-3-39-6-8-11-6-16 7Z"
          fill="#c5c7c5"
          opacity="0.88"
        />
        <path
          d="M224 172c13 22 16 50 7 75-6 17-19 27-38 33 13-18 17-40 11-65-4-17-2-31 5-42 5-7 10-7 15-1Z"
          fill="#b1b4b3"
          opacity="0.72"
        />

        <path
          className="alisha-chest"
          d="M113 139c10-14 24-20 43-20 18 0 33 7 43 22l-4 18 9 12-9 12 6 14-12 9 5 17-15 6 1 18-18 2-7 19-9-17-19-2 1-17-17-6 7-15-14-9 11-13-8-14 13-10-7-14 9-16Z"
          fill="url(#alisha-chest-fur)"
          stroke="#d4d0c8"
          strokeWidth="1"
        />

        <g className="alisha-body-stripes" fill="none" stroke="#757a7b" strokeLinecap="round">
          <path d="M88 181c12 4 22 5 31 2" strokeWidth="5" opacity="0.54" />
          <path d="M84 198c12 5 22 6 31 3" strokeWidth="4.5" opacity="0.46" />
          <path d="M82 216c11 5 20 6 28 4" strokeWidth="4" opacity="0.38" />
          <path d="M214 183c-10 5-18 7-27 5" strokeWidth="5" opacity="0.45" />
          <path d="M220 202c-10 4-19 6-27 4" strokeWidth="4" opacity="0.38" />
        </g>

        <g className="alisha-front-paw alisha-front-paw-left">
          <path
            d="M112 190c14-5 27 2 28 18l1 47c0 17-7 27-23 28-16 0-23-9-22-25l3-48c1-11 5-17 13-20Z"
            fill="#ece9e2"
            stroke="#aaa9a4"
            strokeWidth="1.2"
          />
          <path d="M106 222c9 4 20 4 31 0m-33 15c9 4 21 4 34 0" fill="none" stroke="#7d8181" strokeWidth="3.8" opacity="0.62" />
          <path d="M103 270c7-5 25-5 33 1" fill="none" stroke="#c0bbb2" strokeWidth="1.2" />
          <path d="M112 271v8m12-8v9" stroke="#c0bbb2" strokeWidth="1" />
        </g>

        <g className="alisha-front-paw alisha-front-paw-right">
          <path
            d="M178 190c14-4 25 4 25 20l2 47c1 17-7 26-22 26-16 0-24-10-23-26l2-48c1-10 7-17 16-19Z"
            fill="#ece9e2"
            stroke="#aaa9a4"
            strokeWidth="1.2"
          />
          <path d="M164 222c11 4 23 4 36 0m-36 15c10 4 23 4 37 0" fill="none" stroke="#7d8181" strokeWidth="3.8" opacity="0.62" />
          <path d="M166 270c8-5 26-5 34 1" fill="none" stroke="#c0bbb2" strokeWidth="1.2" />
          <path d="M176 271v8m13-8v9" stroke="#c0bbb2" strokeWidth="1" />
        </g>

        <g className="alisha-fur-lines" fill="none" stroke="#fffdf7" strokeLinecap="round" opacity="0.64">
          <path d="M105 161c12 7 20 9 29 8m-30 7c12 7 20 9 28 9m53-24c-10 6-18 8-27 8m30 8c-10 6-18 8-27 8" />
          <path d="M119 145c6 6 11 10 17 13m45-12c-6 6-11 10-17 13" />
        </g>
      </g>

      <g className="alisha-head">
        <g className="alisha-ear alisha-ear-left">
          <path
            d="M86 81 75 26c-1-7 5-10 11-6l39 31Z"
            fill="url(#alisha-head-fur)"
            stroke="#878b8a"
            strokeWidth="1.4"
          />
          <path d="m87 64-7-34 28 23Z" fill="url(#alisha-ear-inner)" opacity="0.9" />
          <path d="M81 31c9 9 16 18 22 29" fill="none" stroke="#f6e9e4" strokeWidth="3" opacity="0.7" />
        </g>

        <g className="alisha-ear alisha-ear-right">
          <path
            d="m190 49 39-31c6-5 13-1 12 7l-9 57Z"
            fill="url(#alisha-head-fur)"
            stroke="#878b8a"
            strokeWidth="1.4"
          />
          <path d="m207 52 27-24-7 36Z" fill="url(#alisha-ear-inner)" opacity="0.9" />
          <path d="M234 29c-8 10-15 20-20 31" fill="none" stroke="#f6e9e4" strokeWidth="3" opacity="0.7" />
        </g>

        <path
          className="alisha-face"
          d="M88 67c13-24 41-36 70-34 31 1 57 16 69 43 9 22 8 52-5 71-14 21-38 31-67 31-30-1-57-13-69-36-11-21-10-53 2-75Z"
          fill="url(#alisha-head-fur)"
          stroke="#858989"
          strokeWidth="1.6"
        />

        <path
          d="M103 134c10 2 21 7 29 15 7 7 14 13 23 13s17-5 25-13c7-7 17-12 29-13-4 23-25 38-53 39-29-1-49-17-53-41Z"
          fill="#f7f2e9"
          opacity="0.95"
        />
        <path d="M106 65c14 8 27 12 43 12m54-12c-14 8-28 12-44 12" fill="none" stroke="#f8f5ef" strokeWidth="4" opacity="0.7" />

        <g className="alisha-forehead-stripes" fill="none" stroke="#74797a" strokeLinecap="round">
          <path d="M137 42c1 12 5 22 12 31" strokeWidth="5.5" opacity="0.82" />
          <path d="M158 39c0 14-2 25-6 34" strokeWidth="5.2" opacity="0.9" />
          <path d="M179 43c-4 13-10 23-18 31" strokeWidth="5.2" opacity="0.82" />
          <path d="M116 49c5 11 13 20 23 27" strokeWidth="4" opacity="0.5" />
          <path d="M200 52c-6 10-14 18-25 25" strokeWidth="4" opacity="0.5" />
        </g>

        <g className="alisha-eye-open alisha-eye-left" clipPath="url(#alisha-left-eye-clip)" filter="url(#alisha-eye-glow)">
          <path d="M96 105c8-12 25-14 35-3 4 5 3 14-1 20-9 9-25 8-33-1-4-5-4-11-1-16Z" fill="url(#alisha-iris)" />
          <g className="alisha-pupil alisha-pupil-left">
            <ellipse cx="115" cy="112" rx="3.3" ry="12" fill="#211f18" />
            <ellipse cx="110" cy="106" rx="2.2" ry="2.8" fill="#fffce9" opacity="0.92" />
          </g>
          <path d="M95 106c10-13 27-14 37-3" fill="none" stroke="#4d4a38" strokeWidth="2.2" />
        </g>

        <g className="alisha-eye-open alisha-eye-right" clipPath="url(#alisha-right-eye-clip)" filter="url(#alisha-eye-glow)">
          <path d="M166 102c10-10 27-8 34 5 3 6 1 13-4 18-10 7-25 4-31-6-3-6-2-12 1-17Z" fill="url(#alisha-iris)" />
          <g className="alisha-pupil alisha-pupil-right">
            <ellipse cx="183" cy="113" rx="3.3" ry="12" fill="#211f18" />
            <ellipse cx="178" cy="107" rx="2.2" ry="2.8" fill="#fffce9" opacity="0.92" />
          </g>
          <path d="M165 103c10-11 27-9 36 4" fill="none" stroke="#4d4a38" strokeWidth="2.2" />
        </g>

        <g className="alisha-closed-eyes" fill="none" stroke="#554f49" strokeLinecap="round" strokeWidth="2.6">
          <path d="M98 113c10 7 23 7 33-1" />
          <path d="M165 112c10 8 24 8 35 1" />
        </g>

        <path
          className="alisha-nose"
          d="m145 128 10-4 10 5c-1 7-6 10-10 10-5 0-9-4-10-11Z"
          fill="#b66f68"
          stroke="#704e4b"
          strokeWidth="1"
        />
        <path d="M155 138v8m0 0c-5 0-9 3-12 7m12-7c5 0 9 3 12 7" fill="none" stroke="#5f5851" strokeLinecap="round" strokeWidth="1.5" />
        <path className="alisha-mouth-open" d="M146 150c6 5 13 5 19 0-1 10-5 14-10 14-5 0-8-4-9-14Z" fill="#9f5d5a" opacity="0" />

        <g className="alisha-whiskers" fill="none" stroke="#8d8880" strokeLinecap="round" strokeWidth="1" opacity="0.82">
          <path d="M128 140c-22-5-41-5-59-1m58 8c-23 0-43 4-61 11m64-3c-20 5-37 13-51 24" />
          <path d="M180 140c22-4 42-3 59 2m-61 6c24 1 44 6 61 14m-64-7c20 6 36 15 50 26" />
        </g>

        <g className="alisha-cheek-fur" fill="none" stroke="#fffdf8" strokeLinecap="round" opacity="0.75">
          <path d="m92 126-18 5 18 5-14 10m132-20 18 6-18 5 14 10" strokeWidth="2.2" />
        </g>

        {hasBow ? (
          <g className="alisha-bow" aria-hidden="true">
            <path d="M205 56c-15-10-24-8-26 5 1 11 10 15 25 5Z" fill="#b56952" />
            <path d="M211 55c15-10 25-7 26 7-2 11-11 14-26 4Z" fill="#b56952" />
            <circle cx="207" cy="61" r="7" fill="#8f503e" />
          </g>
        ) : null}

        {hasStar ? (
          <path
            className="alisha-keepsake-star"
            d="m221 145 4 9 10 1-8 7 2 10-8-5-9 5 2-10-8-7 11-1Z"
            fill="#efc966"
            stroke="#b58a2f"
            strokeWidth="1"
            aria-hidden="true"
          />
        ) : null}
      </g>

      <g className="alisha-expression-layer" aria-hidden="true">
        <path className="alisha-annoyed-mark" d="M229 59h20m-10-10v20m-4-15 10 10m0-10-10 10" fill="none" stroke="#a65f42" strokeLinecap="round" strokeWidth="3" />
        <g className="alisha-heart-burst" fill="#b86d58">
          <path d="M75 85c-9-8-20 4 1 20 21-16 10-28 1-20l-1 2Z" />
          <path d="M236 104c-7-6-15 3 1 15 16-12 8-21 1-15l-1 2Z" />
        </g>
        <g className="alisha-sleep-marks" fill="none" stroke="#82786d" strokeLinecap="round" strokeLinejoin="round">
          <path d="m227 63 16-1-16 17 17-1" strokeWidth="3" />
          <path d="m247 42 12-1-12 13 13-1" strokeWidth="2.2" />
        </g>
      </g>

      <g className="alisha-hit-regions">
        <path
          className="alisha-hit-zone is-body"
          d="M83 165c-20 25-23 79-4 105 18 25 130 25 158-3 19-19 12-80-5-104-31 24-120 25-149 2Z"
          {...hitProps('点击阿丽莎的身体', onBodyClick)}
        />
        <path
          className="alisha-hit-zone is-head"
          d="M89 63c-22 31-20 79 5 105 30 29 95 28 124-2 25-26 25-77 3-107-32-31-103-30-132 4Z"
          onPointerDown={interactive ? onHeadPointerDown : undefined}
          onPointerMove={interactive ? onHeadPointerMove : undefined}
          onPointerUp={interactive ? onHeadPointerUp : undefined}
          onPointerCancel={interactive ? onHeadPointerUp : undefined}
          onPointerLeave={interactive ? onHeadPointerUp : undefined}
          {...hitProps('轻触或长按抚摸阿丽莎的头', onHeadClick)}
        />
        <path
          className="alisha-hit-zone is-left-ear"
          d="M72 18c-5 3-4 16 0 37l11 36 48-36-43-37c-6-5-12-5-16 0Z"
          {...hitProps('轻点阿丽莎的左耳', onLeftEarClick)}
        />
        <path
          className="alisha-hit-zone is-right-ear"
          d="M231 14c7 0 12 5 11 14l-7 63-52-37 41-36c2-2 5-4 7-4Z"
          {...hitProps('轻点阿丽莎的右耳', onRightEarClick)}
        />
        <path
          className="alisha-hit-zone is-tail"
          d="M165 229c34-12 83-18 108 0 26 19 20 48-8 60-33 13-92 7-111-12-15-15-8-38 11-48Z"
          {...hitProps('轻点阿丽莎的尾巴', onTailClick)}
        />
      </g>
    </svg>
  );
}
