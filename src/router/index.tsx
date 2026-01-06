import { lazy } from 'react';
import { Navigate, RouteObject, createBrowserRouter } from 'react-router';

import ErrorBoundary from '@/components/error-boundary';

import { LazyLoad } from './utils';

const router: RouteObject[] = [
  {
    path: '/',
    errorElement: <ErrorBoundary />,
    children: [
      {
        index: true,
        element: LazyLoad(lazy(() => import('@/pages/converter'))),
      },
      {
        path: '/404',
        element: LazyLoad(lazy(() => import('@/components/not-fount'))),
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/404" />,
  },
];

export default createBrowserRouter(router);
