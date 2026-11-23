<template>
  <div class="auth-bar">
    <div v-if="user" class="auth-user-pill">
      <el-tag type="success" effect="light" size="small">
        {{ user.provider || "OAuth" }}
      </el-tag>
      <span class="auth-username">{{ user.nickname || user.username }}</span>
      <span v-if="user.email" class="auth-email">({{ user.email }})</span>
      <el-button size="small" plain type="danger" :loading="busy" @click="handleLogout">
        退出登录
      </el-button>
    </div>

    <div v-else class="auth-guest-pill">
      <el-tag type="info" effect="plain" size="small">未认证</el-tag>
      <el-button type="primary" size="small" @click="openLoginDialog">
        第三方 OAuth 登录
      </el-button>
    </div>

    <el-dialog
      v-model="dialogVisible"
      title="第三方 OAuth 认证登录"
      width="460px"
      :close-on-click-modal="false"
    >
      <div class="oauth-dialog-body">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="认证机制说明"
          description="传入的 Token 会实时前往 Redis 查询会话数据并解析校验；若 Redis 中查无数据或解析失败，将直接返回 401 未认证。"
          style="margin-bottom: 16px"
        />

        <div class="oauth-section">
          <div class="section-label">方式一：跳转第三方 OAuth 认证中心</div>
          <el-button
            type="primary"
            plain
            style="width: 100%"
            :loading="loadingOAuthUrl"
            @click="handleRedirectOAuth"
          >
            前往 {{ oauthProviderName }} 授权登录
          </el-button>
          <p v-if="oauthHint" class="oauth-hint">{{ oauthHint }}</p>
        </div>

        <el-divider>或</el-divider>

        <div class="oauth-section">
          <div class="section-label">方式二：直接提交 OAuth Token（Redis 校验）</div>
          <el-input
            v-model="tokenInput"
            placeholder="请输入第三方颁发的 OAuth Token"
            clearable
            @keyup.enter="handleTokenLogin"
          />
          <el-button
            type="primary"
            style="width: 100%; margin-top: 10px"
            :loading="busy"
            :disabled="!tokenInput.trim()"
            @click="handleTokenLogin"
          >
            校验 Token 并登录
          </el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  fetchCurrentUser,
  fetchOAuthAuthorizeConfig,
  getStoredAuthToken,
  loginWithOAuth,
  logoutAuth,
  setStoredAuthToken,
  type AuthUser,
} from "../api";

const emit = defineEmits<{
  (e: "auth-change", user: AuthUser | null): void;
}>();

const user = ref<AuthUser | null>(null);
const dialogVisible = ref(false);
const tokenInput = ref("");
const busy = ref(false);
const loadingOAuthUrl = ref(false);
const oauthProviderName = ref("OAuth2 SSO");
const oauthHint = ref("");

async function verifyExistingSession() {
  const params = new URLSearchParams(window.location.search);
  const callbackToken = params.get("token")?.trim();
  const callbackCode = params.get("code")?.trim();
  const callbackState = params.get("state")?.trim() || undefined;

  if (callbackToken || callbackCode) {
    busy.value = true;
    try {
      const res = await loginWithOAuth({
        ...(callbackToken ? { token: callbackToken } : {}),
        ...(callbackCode ? { code: callbackCode, state: callbackState } : {}),
      });
      setStoredAuthToken(res.token);
      user.value = res.user;
      emit("auth-change", res.user);
      ElMessage.success(`OAuth 认证成功，欢迎 ${res.user.nickname || res.user.username}`);
    } catch (err) {
      setStoredAuthToken(null);
      user.value = null;
      emit("auth-change", null);
      ElMessage.error(
        err instanceof Error ? `OAuth 认证失败：${err.message}` : "OAuth 认证失败"
      );
    } finally {
      busy.value = false;
      params.delete("token");
      params.delete("code");
      params.delete("state");
      const nextQuery = params.toString();
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", nextUrl);
    }
    return;
  }

  const stored = getStoredAuthToken();
  if (!stored) {
    user.value = null;
    emit("auth-change", null);
    return;
  }

  try {
    const res = await fetchCurrentUser();
    user.value = res.user;
    emit("auth-change", res.user);
  } catch {
    setStoredAuthToken(null);
    user.value = null;
    emit("auth-change", null);
  }
}

async function openLoginDialog() {
  oauthHint.value = "";
  dialogVisible.value = true;
  loadingOAuthUrl.value = true;
  try {
    const cfg = await fetchOAuthAuthorizeConfig();
    oauthProviderName.value = cfg.providerName || "OAuth2 SSO";
    if (!cfg.configured) {
      oauthHint.value =
        "提示：当前未配置 OAUTH_AUTHORIZE_URL / OAUTH_CLIENT_ID，可直接使用下方 Token 登录验证。";
    }
  } catch {
    // ignore
  } finally {
    loadingOAuthUrl.value = false;
  }
}

async function handleRedirectOAuth() {
  loadingOAuthUrl.value = true;
  try {
    const cfg = await fetchOAuthAuthorizeConfig();
    if (!cfg.configured || !cfg.authorizeUrl) {
      oauthHint.value =
        "服务端尚未配置 OAUTH_AUTHORIZE_URL 与 OAUTH_CLIENT_ID，请先在 .env 中配置或使用下方 Token 校验。";
      ElMessage.warning("尚未配置第三方 OAuth 授权地址");
      return;
    }
    window.location.href = cfg.authorizeUrl;
  } catch (err) {
    ElMessage.error(
      err instanceof Error ? err.message : "获取 OAuth 授权地址失败"
    );
  } finally {
    loadingOAuthUrl.value = false;
  }
}

async function handleTokenLogin() {
  const token = tokenInput.value.trim();
  if (!token) return;
  busy.value = true;
  try {
    const res = await loginWithOAuth({ token });
    setStoredAuthToken(res.token);
    user.value = res.user;
    dialogVisible.value = false;
    tokenInput.value = "";
    emit("auth-change", res.user);
    ElMessage.success(`认证成功：${res.user.nickname || res.user.username}`);
  } catch (err) {
    ElMessage.error(
      err instanceof Error ? `未认证：${err.message}` : "未认证：Token 校验失败"
    );
  } finally {
    busy.value = false;
  }
}

async function handleLogout() {
  busy.value = true;
  try {
    await logoutAuth().catch(() => {});
  } finally {
    setStoredAuthToken(null);
    user.value = null;
    busy.value = false;
    emit("auth-change", null);
    ElMessage.info("已退出登录");
  }
}

onMounted(() => {
  void verifyExistingSession();
});
</script>

<style scoped>
.auth-bar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 10px 24px 0;
}

.auth-user-pill,
.auth-guest-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #ffffff;
  border: 1px solid #e4e7ed;
  border-radius: 999px;
  padding: 5px 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}

.auth-username {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.auth-email {
  font-size: 12px;
  color: #909399;
}

.oauth-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.oauth-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #e6a23c;
}
</style>
