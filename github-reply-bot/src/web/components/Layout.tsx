import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';

export function Layout() {
  const { logout } = useAuth();
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            🤖
          </span>
          <span>GitHub 回复助手</span>
        </div>
        <nav className="app-nav" aria-label="主导航">
          <NavLink to="/" end>
            概览
          </NavLink>
          <NavLink to="/repos">仓库</NavLink>
          <NavLink to="/runs">运行记录</NavLink>
          <NavLink to="/settings">全局设置</NavLink>
        </nav>
        <button type="button" className="btn btn-ghost" onClick={logout}>
          退出登录
        </button>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer">
        自托管 · 数据保存在本机 SQLite · 默认关闭自动化，请先审查再发布
      </footer>
    </div>
  );
}
