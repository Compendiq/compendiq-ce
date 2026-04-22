/**
 * ChartsBundle — centralized re-exports of the recharts primitives we use.
 *
 * Consumers import named members directly; recharts stays out of the main
 * bundle via Vite `manualChunks` (`frontend/vite.config.ts`, key `recharts`):
 *
 *   // In a consuming component — relative path matches the convention used
 *   // by existing consumers in frontend/src/features/admin/analytics/*.tsx:
 *   import { LineChart, Line, XAxis, YAxis } from '../../../shared/components/charts/ChartsBundle';
 */
export {
  LineChart,
  BarChart,
  PieChart,
  AreaChart,
  Treemap,
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
