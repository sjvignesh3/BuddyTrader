import { Routes, Route } from "react-router-dom";
import Header from "./components/Header";
import HomePage from "./pages/HomePage";
import JournalPage from "./pages/JournalPage";
import ExpensesPage from "./pages/ExpensesPage";
import PositionSizerPage from "./pages/PositionSizerPage";
import NetWorthPage from "./pages/NetWorthPage";
import PoolsPage from "./pages/PoolsPage";
import PoolDetailPage from "./pages/PoolDetailPage";
import StockDetailPage from "./pages/StockDetailPage";
import SyncStatusPage from "./pages/SyncStatusPage";

export default function App() {
  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-4 py-4 sm:py-6">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/journal" element={<JournalPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/position-sizer" element={<PositionSizerPage />} />
          <Route path="/net-worth" element={<NetWorthPage />} />
          <Route path="/pools" element={<PoolsPage />} />
          <Route path="/pools/:code" element={<PoolDetailPage />} />
          <Route path="/stocks/:symbol" element={<StockDetailPage />} />
          <Route path="/status" element={<SyncStatusPage />} />
        </Routes>
      </main>
      <footer className="py-5 text-center text-[11px] text-brand-mute select-none">
        Made for <span className="font-display font-semibold text-brand-text">Vicky</span>
        {" "}&amp; By <span className="font-display font-semibold text-brand-text">Vicky</span>
        {" "}<span className="text-rose-500">♥</span>
      </footer>
    </div>
  );
}
