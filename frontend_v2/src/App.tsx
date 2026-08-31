import { Routes, Route, Navigate } from "react-router-dom";
import Header from "./components/Header";
import PoolsPage from "./pages/PoolsPage";
import PoolDetailPage from "./pages/PoolDetailPage";
import SyncStatusPage from "./pages/SyncStatusPage";

export default function App() {
  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/pools" replace />} />
          <Route path="/pools" element={<PoolsPage />} />
          <Route path="/pools/:code" element={<PoolDetailPage />} />
          <Route path="/status" element={<SyncStatusPage />} />
        </Routes>
      </main>
    </div>
  );
}
