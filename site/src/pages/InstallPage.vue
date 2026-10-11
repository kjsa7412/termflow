<script setup lang="ts">
import CodeBlock from '../components/CodeBlock.vue';

/** 설치 — 요구 사항 · Windows PC · Linux 서버(온라인 · 오프라인 번들) · 첫 로그인 · 운영. 자세한 절차는 제품 안 설치·운영 가이드. */
const ver = __TF_VERSION__;
const LINUX_ONLINE = `# 1) 소스 받기(설치 폴더 /opt/termflow)
sudo git clone --branch v${ver} <저장소 주소> /opt/termflow
# 2) 설치 — .env 생성(비밀값 난수) · 부팅 시 기동 · 매일 백업 · 기동
sudo /opt/termflow/install.sh`;
const BUNDLE_MAKE = `# 인터넷이 되는 PC(Windows는 Git Bash)에서 — 소스 + 이미지(app · postgres)를 파일 하나로
scripts/bundle.sh            # → release/termflow-linux-${ver}.tar.gz (+ .sha256)`;
const BUNDLE_COPY = `# 개발 PC → 서버 /tmp/ (Windows도 PowerShell에 scp · ssh가 있다. SSH가 막혔으면 USB 등으로 같은 두 파일을)
scp release/termflow-linux-${ver}.tar.gz release/termflow-linux-${ver}.tar.gz.sha256 <계정>@<서버>:/tmp/
ssh <계정>@<서버>`;
const BUNDLE_INSTALL = `# 서버 — 처음 설치
cd /tmp && sha256sum -c termflow-linux-${ver}.tar.gz.sha256
sudo mkdir -p /opt/termflow
sudo tar -xzf /tmp/termflow-linux-${ver}.tar.gz -C /opt/termflow --strip-components=1 --no-same-owner
sudo /opt/termflow/install.sh`;
const BUNDLE_UPGRADE = `# 서버 — 업그레이드(체크섬 → 백업 → 풀기 → install.sh, .env · backup · logs는 그대로)
sudo bash /opt/termflow/scripts/upgrade.sh /tmp/termflow-linux-${ver}.tar.gz`;
const WINDOWS = `# 설치 폴더(예 C:\\TermFlow)에서 — .env를 만들고 비밀값 3개를 채운 뒤
copy .env.example .env
start.bat`;
const OPS = `./start.sh                         # 기동(Docker · .env 검사 → db → app)
docker compose ps                  # 상태 — db · app 둘 다 healthy
scripts/backup.sh                  # 백업 → backup/termflow_yyyyMMdd.dump(14일 보관)
scripts/restore.sh backup/termflow_20261001.dump    # 복구(확인 문구 RESTORE)
systemctl list-timers termflow-backup.timer         # 매일 02:00 백업 타이머`;
const AGENT_ENABLE = `# 서버 .env — 외부 연동(접근 토큰 · /mcp) 켜기. 기본은 꺼짐
TERMFLOW_MCP_ENABLED=true
# 설치 폴더에서 app 다시 만들기
sudo docker compose up -d app`;
const AGENT_CONFIG = `{
  "mcpServers": {
    "termflow": {
      "type": "http",
      "url": "http://<서버 주소>:7340/mcp",
      "headers": { "Authorization": "Bearer tfp_…" }
    }
  }
}`;
</script>

<template>
  <div class="wrap page">
    <h1 tabindex="-1">설치</h1>
    <p class="lead">
      TermFlow는 앱 이미지 하나와 PostgreSQL 17을 Docker Compose로 띄운다. 회사 안 PC 한 대나 Linux
      서버 한 대면 된다. 운영에는 Node.js가 필요 없다.
    </p>

    <section class="sec">
      <h2>요구 사항</h2>
      <div class="table-box">
        <table class="tbl">
          <thead>
            <tr>
              <th>항목</th>
              <th>Windows PC</th>
              <th>Linux 서버</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">OS</th>
              <td>Windows 10/11 64비트</td>
              <td>
                x86-64 Linux(Ubuntu · Debian · RHEL 계열 등). systemd가 있으면 부팅 시 기동·백업
                타이머를 등록한다
              </td>
            </tr>
            <tr>
              <th scope="row">Docker</th>
              <td>Docker Desktop 4.x(WSL2), Compose v2</td>
              <td>Docker Engine + compose 플러그인 v2</td>
            </tr>
            <tr>
              <th scope="row">메모리 · 디스크</th>
              <td colspan="2">메모리 2GB 이상(앱 + DB 수백 MB) · 디스크 여유 5GB 이상</td>
            </tr>
            <tr>
              <th scope="row">네트워크</th>
              <td>처음 이미지 빌드 때만 인터넷</td>
              <td>인터넷이 없으면 오프라인 번들(아래)</td>
            </tr>
            <tr>
              <th scope="row">포트</th>
              <td colspan="2">
                7340(앱) · 7341(DB) — 흔한 서비스 포트(8080 · 5432 등)와 겹치지 않게 골랐다. 겹치면
                바꾼다
              </td>
            </tr>
            <tr>
              <th scope="row">브라우저</th>
              <td colspan="2">Chrome · Edge 최신 2개 판</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="linux" class="sec">
      <h2>Linux 서버</h2>
      <ol class="steps">
        <li>
          <b>설치 스크립트 한 번.</b> <span class="mono">install.sh</span>가 Docker·compose를
          확인하고, <span class="mono">.env</span>가 없으면 만들어 비밀값 3개(DB · 초기 관리자 ·
          세션 키)를 난수로 채운다(권한 600, 화면에 내지 않는다). root로 실행하면
          <b>부팅 시 기동</b>(<span class="mono">termflow.service</span>)과
          <b>매일 02:00 백업</b>(<span class="mono">termflow-backup.timer</span>)을 등록하고,
          마지막에 <span class="mono">start.sh</span>로 기동한다.
          <CodeBlock :code="LINUX_ONLINE" />
        </li>
        <li>
          <b>폐쇄망이면 오프라인 번들.</b> 인터넷이 되는 PC에서 번들을 만들어 반입한다.
          <span class="mono">install.sh</span>는 <span class="mono">images/</span>의 이미지 파일을
          <span class="mono">docker load</span> 하고 빌드하지 않는다.
          <CodeBlock :code="BUNDLE_MAKE" />
          번들과 체크섬 두 파일을 서버로 옮긴다.
          <CodeBlock :code="BUNDLE_COPY" />
          <CodeBlock :code="BUNDLE_INSTALL" />
        </li>
        <li>
          <b>업그레이드는 한 줄.</b> 새 번들을 같은 방법으로 <span class="mono">/tmp/</span>에
          옮기고 실행한다 — 체크섬 확인 → 백업 → 풀기 → 새 이미지로 다시 기동(DB 스키마 자동 적용).
          <CodeBlock :code="BUNDLE_UPGRADE" />
        </li>
        <li>
          <b>옵션.</b> <span class="mono">--port 7350</span>(앱 포트, 기본 7340) ·
          <span class="mono">--migrate yes|no|ask</span>(초기 데이터 적재) ·
          <span class="mono">--no-systemd</span> · <span class="mono">--no-start</span>. 다시
          실행해도 된다 — 있는 <span class="mono">.env</span>·데이터·서비스는 그대로 두고 빠진 것만
          채운다.
        </li>
      </ol>
    </section>

    <section id="windows" class="sec">
      <h2>Windows PC</h2>
      <ol class="steps">
        <li>
          Docker Desktop을 켠다. 설치 폴더에 소스를 두고 <span class="mono">.env</span>에 비밀값
          3개를 채운다(만드는 명령은 설치·운영 가이드 §3.2).
        </li>
        <li>
          <span class="mono">start.bat</span> 더블클릭 — Docker 확인 →
          <span class="mono">.env</span> 검사 → DB → 초기 데이터(처음 한 번 묻는다) → 앱 → 브라우저.
          <CodeBlock :code="WINDOWS" label="cmd" />
        </li>
      </ol>
    </section>

    <section class="sec">
      <h2>첫 로그인</h2>
      <ol class="steps">
        <li>
          브라우저로 <span class="mono">http://&lt;서버 주소&gt;:7340</span>. 아이디
          <span class="mono">admin</span>, 비밀번호는 <span class="mono">.env</span>의
          <span class="mono">TERMFLOW_ADMIN_PASSWORD</span>.
        </li>
        <li>
          <b>비밀번호 변경 화면으로 바로 이동한다</b>(강제). 바꾼 뒤로는
          <span class="mono">.env</span> 값이 쓰이지 않는다.
        </li>
        <li>
          [시스템 › 사용자]에서 계정을 만든다 — 초기 비밀번호는 한 번만 보인다. 시스템 관리자는 두
          명 이상 둔다.
        </li>
        <li>사용법은 제품 상단 바의 <b>?</b> 단추(설명서). 로그인 화면에서도 열린다.</li>
      </ol>
    </section>

    <section id="agent" class="sec">
      <h2>에이전트 연동(선택, v1.3.0~)</h2>
      <ol class="steps">
        <li>
          시스템 관리자가 서버에서 외부 연동을 켠다. 켜면 사용자의 에이전트가 표준 사전·테이블
          정의를 가져가 그 에이전트의 모델 서비스로 보낼 수 있으므로 회사 정보보호 기준으로 정한다.
          <CodeBlock :code="AGENT_ENABLE" />
        </li>
        <li>
          사용자는 제품의 <b>[내 계정] › 외부 연동 접근 토큰</b>에서 토큰을 발급한다(30일~1년, 한
          번만 보인다). 토큰은 발급한 사람의 역할 그대로 쓰인다.
        </li>
        <li>
          화면에 함께 나오는 연결 설정을 에이전트 도구(MCP 클라이언트)의 설정 파일에 넣는다.
          <CodeBlock :code="AGENT_CONFIG" label="json" />
        </li>
      </ol>
    </section>

    <section class="sec">
      <h2>운영 한눈에</h2>
      <CodeBlock :code="OPS" />
      <p class="note">
        Linux 업그레이드는 위의 <span class="mono">scripts/upgrade.sh</span> 한 줄(백업 포함),
        Windows는 새 판 소스로 <span class="mono">start.bat -Build</span>. 자세한 절차(HTTPS 프록시
        · 복구 · 문제 해결)는 제품 안 <b>설치·운영 가이드</b>(시스템 관리자).
      </p>
    </section>
  </div>
</template>
