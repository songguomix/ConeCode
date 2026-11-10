import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { token, login } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const candidate = value.trim();
    if (!candidate) {
      setError('请输入 ADMIN_TOKEN');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(candidate);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>GitHub 回复助手</h1>
        <p className="muted">输入部署时配置的 `ADMIN_TOKEN` 以管理草稿、仓库开关与运行记录。</p>
        <label className="field">
          <span>管理员令牌</span>
          <input
            type="password"
            name="token"
            autoComplete="current-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="ADMIN_TOKEN"
          />
        </label>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="hint">令牌只保存在当前浏览器标签页，不做持久化。</p>
      </form>
    </div>
  );
}
