import { useEffect } from 'react';

/**
 * 让容器横向自动滚动，鼠标进入时暂停、离开时恢复。
 * 适用于 Travel 视频轨道。
 */
export function useHorizontalAutoScroll(ref, speed = 0.5) {
  useEffect(() => {
    const slider = ref.current;
    if (!slider) return undefined;

    let scrollAmount = 0;
    let animationFrame;
    let paused = false;

    const step = () => {
      if (!paused) {
        scrollAmount += speed;
        slider.scrollLeft = scrollAmount;
        if (scrollAmount >= slider.scrollWidth / 2) {
          scrollAmount = 0;
          slider.scrollLeft = 0;
        }
      }
      animationFrame = requestAnimationFrame(step);
    };

    animationFrame = requestAnimationFrame(step);

    const stop = () => {
      paused = true;
    };
    const start = () => {
      paused = false;
    };

    slider.addEventListener('mouseenter', stop);
    slider.addEventListener('mouseleave', start);

    return () => {
      cancelAnimationFrame(animationFrame);
      slider.removeEventListener('mouseenter', stop);
      slider.removeEventListener('mouseleave', start);
    };
  }, [ref, speed]);
}
