import { FC, ReactNode, Suspense } from 'react';

/**
 * 组件懒加载，结合Suspense实现
 * @param Component 组件对象
 * @returns 返回新组件
 */
export const LazyLoad = (Component: FC): ReactNode => {
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  );
};
