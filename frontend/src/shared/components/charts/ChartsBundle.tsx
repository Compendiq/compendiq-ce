/**
 * ChartsBundle — re-exports recharts primitives as a single lazy-loadable module.
 *
 * Consumers lazy-load this entire module so recharts stays in its own chunk
 * and never bloats the main bundle:
 *
 *   const ChartsBundle = lazy(() => import('../../shared/components/charts/ChartsBundle'));
 *   <Suspense fallback={<Spinner />}><ChartsBundle … /></Suspense>
 */
export {
  LineChart,
  BarChart,
  PieChart,
  AreaChart,
  ResponsiveContainer,
  Line,
  Bar,
  Pie,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  Cell,
} from 'recharts';
