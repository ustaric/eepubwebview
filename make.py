import json
import logging
import os
import re
from pathlib import Path

# ==========================================
# 0. 표준 로깅 설정
# ==========================================
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger(__name__)

# ==========================================
# 1. 서버 프로젝트 상수 및 제외 대상 정의
# ==========================================
EXCLUDE_DIRS = {
    ".git", ".github", "node_modules", "dist", ".vscode", "__pycache__",
    "vendor", "tests", "data", "logs", "temp", "uploads", ".cache"  # 서버 데이터/로그 폴더 배제
}
EXCLUDE_FILES = {
    "package-lock.json", "make.py", "파일안내.md", "리프레시서버파일안내.md", ".DS_Store", ".env"
}

CATEGORY_ORDER = [
    "EntryPoint (서버 진입점 & 라우팅)",
    "Auth & Security (인증 & 토큰 보안)",
    "Storage Engine (자체 스토리지 서비스)",
    "Admin & Monitoring (관리자 관제 & 감사 로그)",
    "Config & Metadata (설정 및 패키지)"
]

# ==========================================
# 2. 파일 분석 및 정밀 파싱 헬퍼
# ==========================================

def format_file_size(size_bytes):
    """
    바이트 크기를 읽기 쉬운 B, KB, MB 단위로 자동 변환합니다.
    """
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.2f} MB"


def get_file_category(rel_path_str):
    """
    서버 상대 경로를 기반으로 카테고리를 정밀 분류합니다.
    """
    path_norm = rel_path_str.replace("\\", "/")
    
    if path_norm in ["server.js", "app.js", "index.js"]:
        return "EntryPoint (서버 진입점 & 라우팅)"
    elif any(k in path_norm for k in ["googleAuth", "tokenStore", "envManager", "auth"]):
        return "Auth & Security (인증 & 토큰 보안)"
    elif any(k in path_norm for k in ["storageService", "storage"]):
        return "Storage Engine (자체 스토리지 서비스)"
    elif any(k in path_norm for k in ["adminController", "adminViews", "auditLogger", "admin", "audit"]):
        return "Admin & Monitoring (관리자 관제 & 감사 로그)"
    else:
        return "Config & Metadata (설정 및 패키지)"


def parse_js_doc_summary(content):
    """
    파일 최상단 JSDoc (/** ... */) 블록에서 핵심 역할 요약 문구를 추출합니다.
    """
    jsdoc_match = re.search(r'/\*\*([\s\S]*?)\*/', content)
    if not jsdoc_match:
        # 단일행 주석(// ...) 폴백 탐색
        single_match = re.search(r'^\s*//\s*(.*)', content)
        if single_match and not single_match.group(1).startswith('eslint'):
            return single_match.group(1).strip()
        return "서버 보조 모듈 및 설정"
    
    lines = jsdoc_match.group(1).splitlines()
    for line in lines:
        cleaned = re.sub(r'^\s*\*\s*(@module|@file|@author|@version|@param|@returns)?\s*', '', line).strip()
        if cleaned and not cleaned.startswith('-') and not cleaned.startswith('파일 경로:') and not cleaned.startswith('http'):
            return cleaned
            
    return "서버 보조 모듈 및 설정"


def parse_dependencies(content):
    """
    ESM import 문과 Node.js CommonJS require 문을 전수 분석하여 로컬 참조 파일명 목록을 추출합니다.
    """
    deps = set()
    
    # 1. ESM import 분석
    import_matches = re.findall(r'''(?:import\s+.*?from\s+['"]|import\s+['"])(.*?)(?:['"])''', content)
    for imp in import_matches:
        if imp.startswith('.') or imp.startswith('/'):
            file_name = Path(imp).name
            if file_name:
                if not file_name.endswith('.js'):
                    file_name += '.js'
                deps.add(file_name)

    # 2. CommonJS require 분석
    require_matches = re.findall(r'''require\(\s*['"](.*?)['"]\s*\)''', content)
    for req in require_matches:
        if req.startswith('.') or req.startswith('/'):
            file_name = Path(req).name
            if file_name:
                if not file_name.endswith('.js'):
                    file_name += '.js'
                deps.add(file_name)

    return sorted(list(deps))


def parse_pure_export_functions(content):
    """
    ESM export 및 Node.js module.exports / exports 구문에서 실제 공개된 함수와 클래스를 선별합니다.
    """
    signatures = []
    
    # 1. ESM export async function / export function
    func_matches = re.findall(r'export\s+(async\s+function\s+([a-zA-Z0-9_$]+)|function\s+([a-zA-Z0-9_$]+))', content)
    for m in func_matches:
        fn_name = m[1] or m[2]
        signatures.append(f"{fn_name}()")
        
    # 2. ESM export class
    class_matches = re.findall(r'export\s+class\s+([a-zA-Z0-9_$]+)', content)
    for cls in class_matches:
        signatures.append(f"class {cls}")

    # 3. CommonJS: exports.myFunc = ... / exports.MyClass = ...
    cjs_prop_matches = re.findall(r'exports\.([a-zA-Z0-9_$]+)\s*=', content)
    for p in cjs_prop_matches:
        signatures.append(f"{p}()")

    # 4. CommonJS: module.exports = { fn1, fn2, ... }
    mod_exports_match = re.search(r'module\.exports\s*=\s*\{([\s\S]*?)\}', content)
    if mod_exports_match:
        items = mod_exports_match.group(1).split(',')
        for it in items:
            cleaned = it.split(':')[0].strip()
            cleaned = re.sub(r'[\r\n\s]', '', cleaned)
            if cleaned and re.match(r'^[a-zA-Z0-9_$]+$', cleaned):
                signatures.append(f"{cleaned}()")

    # 5. ESM export const (객체/싱글톤 모듈 fallback)
    if not signatures:
        const_matches = re.findall(r'export\s+const\s+([a-zA-Z0-9_$]+)', content)
        for c_name in const_matches[:6]:
            signatures.append(c_name)

    # 중복 제거
    seen = set()
    unique_sigs = []
    for s in signatures:
        if s not in seen:
            seen.add(s)
            unique_sigs.append(s)

    # 1개 파일당 최대 12개 유지 (초과 시 축약)
    if len(unique_sigs) > 12:
        extra_count = len(unique_sigs) - 12
        return unique_sigs[:12] + [f"외 {extra_count}개"]
        
    return unique_sigs


# ==========================================
# 3. 서버 전용 마크다운 템플릿 생성 루틴
# ==========================================

def generate_header(root_dir_name):
    mermaid_block = "\n".join([
        "```mermaid",
        "graph TD",
        "    A[Web Reader Client <br> 웹 뷰어 / 서재] -->|REST API 요청| B[server.js <br> Express 라우터 & 미들웨어]",
        "    B -->|OAuth 토큰 발급/갱신| C[googleAuth.js <br> Google OAuth2 클라이언트]",
        "    C -->|토큰 암호화 영구 보관| D[tokenStore.js <br> 토큰 파일 스토리지]",
        "    B -->|도서/표지/설정 바이너리 I/O| E[storageService.js <br> 자체 스토리지 엔진]",
        "    E -->|실물 파일 저장| F[(./data/ 폴더 <br> books / covers / settings)]",
        "    B -->|관리자 웹 콘솔 조회| G[adminController.js / adminViews.js <br> 관제 UI 대시보드]",
        "    B -->|보안 감사 이벤트 기록| H[auditLogger.js <br> 감사 로그 로거]",
        "    B -->|환경 변수 관리| I[envManager.js <br> .env 설정 거버넌스]",
        "```"
    ])

    return (
        "# 📄 Refresh & Storage Server - 기술 사양 및 파일 안내서\n"
        f"> **기준 경로**: `{root_dir_name}` | **구조**: Ultra-Compact Modular Server Specs (Optimized for LLM Context)\n\n"
        "> **[🤖 AI Context Instructions]**\n"
        "> - **Architecture**: `Client(Web Reader)` -> `server.js`(Express API) -> `storageService.js`(File I/O) / `googleAuth.js`(OAuth) / `adminController.js`\n"
        "> - **Storage Rule**: 도서 바이너리(`/api/storage/books/:id/epub`), 표지(`/api/storage/covers/:fileName`), 설정(`/api/storage/settings/:name`)으로 분기 제어합니다.\n"
        "> - **Security Rule**: 모든 토큰은 `tokenStore.js`를 거쳐 안전하게 관리되며, 모든 주요 관리자 액션은 `auditLogger.js`를 통해 추적됩니다.\n\n"
        "---\n"
        "## 🛠 1. 전체 서버 시스템 아키텍처 흐름\n"
        f"{mermaid_block}\n\n"
        "---\n"
        "## 📁 2. 파일 카탈로그 요약\n"
    )


# ==========================================
# 4. 메인 실행 진입점 (Main Routine)
# ==========================================

def main():
    current_work_dir = Path.cwd().resolve()
    logger.info(f"🚀 [make.py] 서버 전용 사양서 작성 시작: {current_work_dir}")

    file_entries = []

    for path in current_work_dir.rglob("*"):
        if not path.is_file():
            continue
            
        if any(ex in path.parts for ex in EXCLUDE_DIRS):
            continue
        if path.name in EXCLUDE_FILES:
            continue

        if path.suffix not in {".js", ".json", ".html", ".css", ".ts", ".mjs", ".cjs"}:
            continue

        rel_path = path.relative_to(current_work_dir)
        rel_path_str = rel_path.as_posix()

        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
            lines_count = len(content.splitlines())
            file_size_bytes = path.stat().st_size
            file_size_str = format_file_size(file_size_bytes)
        except Exception as e:
            logger.warn(f"파일 읽기 오류 ({rel_path_str}): {e}")
            continue

        summary = parse_js_doc_summary(content)
        category = get_file_category(rel_path_str)
        deps = parse_dependencies(content)
        signatures = parse_pure_export_functions(content)

        file_entries.append({
            "name": path.name,
            "path": rel_path_str,
            "lines": lines_count,
            "size": file_size_str,
            "category": category,
            "summary": summary,
            "deps": deps,
            "signatures": signatures
        })

    logger.info(f"선별 완료: 핵심 {len(file_entries)}개 서버 파일. 마크다운 빌드 시작...")

    md_lines = []
    md_lines.append(generate_header(current_work_dir.name))

    categorized = {cat: [] for cat in CATEGORY_ORDER}
    for entry in file_entries:
        cat = entry["category"]
        if cat not in categorized:
            categorized[cat] = []
        categorized[cat].append(entry)

    # 섹션 2: 파일 카탈로그 요약 표 렌더링
    for cat_name in CATEGORY_ORDER:
        entries = categorized.get(cat_name, [])
        if not entries:
            continue

        md_lines.append(f"### 🖥️ {cat_name}")
        md_lines.append("| 파일명 | 파일 경로 | 라인 | 용량 | 역할 요약 |")
        md_lines.append("| :--- | :--- | :---: | :---: | :--- |")
        
        for item in sorted(entries, key=lambda x: x["name"].lower()):
            md_lines.append(f"| **`{item['name']}`** | `{item['path']}` | {item['lines']} | {item['size']} | {item['summary']} |")
        
        md_lines.append("\n")

    # 섹션 3: 핵심 모듈 공개 인터페이스 (Public APIs) 렌더링
    md_lines.append("---\n## 🧩 3. 핵심 모듈 공개 인터페이스 (Public APIs)\n")
    md_lines.append("> *서버 핵심 모듈의 의존성 및 Export 인터페이스 명세입니다.*\n")

    target_api_entries = [
        e for e in file_entries 
        if e["path"].endswith(".js") or e["path"].endswith(".mjs") or e["path"].endswith(".cjs")
    ]

    for item in sorted(target_api_entries, key=lambda x: x["path"].lower()):
        if not item["deps"] and not item["signatures"]:
            continue

        md_lines.append(f"#### 📄 `{item['path']}`")
        
        # 1. 참조 모듈 (Dependencies)
        if item["deps"]:
            deps_str = ", ".join([f"`{d}`" for d in item["deps"]])
            md_lines.append(f"- **참조 (Dependencies)**: {deps_str}")

        # 2. 핵심 구현 함수/클래스/메서드 (Exports)
        if item["signatures"]:
            sigs_str = ", ".join([f"`{s}`" for s in item["signatures"]])
            md_lines.append(f"- **핵심 API (Exports)**: {sigs_str}")
        
        md_lines.append("")

    # 🎯 현재 폴더에 '리프레시서버파일안내.md' 및 '파일안내.md' 저장
    output_filename = "리프레시서버파일안내.md" if current_work_dir.name == "refresh-server" or "server" in current_work_dir.name else "파일안내.md"
    output_path = current_work_dir / output_filename
    output_path.write_text("\n".join(md_lines), encoding="utf-8")
    
    final_output_size = format_file_size(output_path.stat().st_size)
    logger.info(f"🎉 [성공] 서버 사양서 작성 완료: {output_path} (크기: {final_output_size})")


if __name__ == "__main__":
    main()