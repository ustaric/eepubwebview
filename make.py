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
# 1. 프로젝트 상수 및 제외 대상 정의
# ==========================================
EXCLUDE_DIRS = {
    ".git", ".github", "node_modules", "dist", ".vscode", "__pycache__",
    "vendor", "tests", "rollup"  # 외부 번들 및 테스트 배제
}
EXCLUDE_FILES = {
    "package-lock.json", "make.py", "파일안내.md", ".DS_Store", "eslint.config.js"
}

# Foliate-js 코어 중 우리가 직접 관리/참조하는 3대 핵심 파일 (나머지는 1줄로 자동 요약)
CORE_FOLIATE_HIGHLIGHTS = {"paginator.js", "view.js", "epub.js"}

CATEGORY_ORDER = [
    "EntryPoint (앱 진입점)",
    "Core Engine (코어 조판 & 라이프사이클)",
    "Data Loaders & Parsers (도서 로딩 & TXT 파서)",
    "Storage & Cloud Services (스토리지 & 클라우드 대사)",
    "Hardware Input & Events (입력 제어 & 제스처)",
    "UI Controllers & Modals (서재 & 설정 패널)",
    "Foliate-js Core Engine (오픈소스 코어)",
    "Styles & Config (스타일 및 설정)"
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
    상대 경로를 기반으로 카테고리를 정밀 분류합니다.
    """
    path_norm = rel_path_str.replace("\\", "/")
    
    if path_norm in ["web/index.html", "web/main.js", "index.html", "main.js"]:
        return "EntryPoint (앱 진입점)"
    elif "/core/" in path_norm:
        return "Core Engine (코어 조판 & 라이프사이클)"
    elif "/loaders/" in path_norm or path_norm.endswith("txtParser.js"):
        return "Data Loaders & Parsers (도서 로딩 & TXT 파서)"
    elif "/services/" in path_norm or path_norm.endswith("db.js") or path_norm.endswith("storage.js") or path_norm.endswith("gdrive.js"):
        return "Storage & Cloud Services (스토리지 & 클라우드 대사)"
    elif "/events/" in path_norm:
        return "Hardware Input & Events (입력 제어 & 제스처)"
    elif "/ui/" in path_norm and not path_norm.startswith("foliate-js"):
        return "UI Controllers & Modals (서재 & 설정 패널)"
    elif "foliate-js" in path_norm:
        return "Foliate-js Core Engine (오픈소스 코어)"
    else:
        return "Styles & Config (스타일 및 설정)"


def parse_js_doc_summary(content):
    """
    파일 최상단 JSDoc (/** ... */) 블록에서 핵심 역할 요약 문구를 추출합니다.
    """
    jsdoc_match = re.search(r'/\*\*([\s\S]*?)\*/', content)
    if not jsdoc_match:
        return "프로젝트 보조 모듈 및 설정"
    
    lines = jsdoc_match.group(1).splitlines()
    for line in lines:
        cleaned = re.sub(r'^\s*\*\s*(@module|@file|@author|@version|@param|@returns)?\s*', '', line).strip()
        if cleaned and not cleaned.startswith('-') and not cleaned.startswith('파일 경로:'):
            return cleaned
            
    return "프로젝트 보조 모듈 및 설정"


def parse_dependencies(content):
    """
    import 문을 전수 분석하여 로컬 참조 파일명 목록을 추출합니다.
    """
    deps = set()
    import_matches = re.findall(r'''(?:import\s+.*?from\s+['"]|import\s+['"])(.*?)(?:['"])''', content)
    for imp in import_matches:
        if imp.startswith('.') or imp.startswith('/'):
            file_name = Path(imp).name
            if file_name and file_name.endswith('.js'):
                deps.add(file_name)
    return sorted(list(deps))


def parse_pure_export_functions(content):
    """
    단순 Re-export나 Getter 상수를 억제하고, 해당 파일이 직접 구현한 진짜 핵심 함수와 클래스만 선별합니다.
    """
    signatures = []
    
    # 1. export async function / export function 만 선별 (진짜 구현 함수)
    func_matches = re.findall(r'export\s+(async\s+function\s+([a-zA-Z0-9_$]+)|function\s+([a-zA-Z0-9_$]+))', content)
    for m in func_matches:
        fn_name = m[1] or m[2]
        signatures.append(f"{fn_name}()")
        
    # 2. export class 선별
    class_matches = re.findall(r'export\s+class\s+([a-zA-Z0-9_$]+)', content)
    for cls in class_matches:
        signatures.append(f"class {cls}")

    # 3. 만약 export function이 아예 없는 순수 싱글톤 객체/상수 모듈인 경우에만 export const 선별 (최대 5개)
    if not signatures:
        const_matches = re.findall(r'export\s+const\s+([a-zA-Z0-9_$]+)', content)
        for c_name in const_matches[:5]:
            signatures.append(c_name)

    # 중복 제거
    seen = set()
    unique_sigs = []
    for s in signatures:
        if s not in seen:
            seen.add(s)
            unique_sigs.append(s)

    # 🌟 [다이어트 핵심] 1개 파일당 핵심 API가 12개를 초과하면 상위 12개 + 외 N개로 압축
    if len(unique_sigs) > 12:
        extra_count = len(unique_sigs) - 12
        return unique_sigs[:12] + [f"외 {extra_count}개"]
        
    return unique_sigs


# ==========================================
# 3. 마크다운 템플릿 생성 루틴
# ==========================================

def generate_header(root_dir_name):
    mermaid_block = "\n".join([
        "```mermaid",
        "graph TD",
        "    A[index.html <br> 서재/뷰어 UI] -->|파일 선택 / 서재 클릭| B[main.js <br> 앱 컨트롤러]",
        "    B -->|도서 로드 요청| C[bookLoader.js <br> 파싱 및 복원]",
        "    C -->|TXT 파일 감지| D[txtParser.js <br> 가상 EPUB ZIP 생성]",
        "    C -->|EPUB 원본 파일| E[viewerCore.js <br> 뷰어 세션 제어]",
        "    E -->|인스턴스 바인딩| F[foliate-view <br> view.js]",
        "    F -->|다단 분할 연산| G[paginator.js <br> CSS Grid 레이아웃]",
        "    E -.->|오버라이드 스타일 주입| H[Isolated iframe Body]",
        "    B <-->|읽기위치 / 설정 저장| I[(IndexedDB / LocalStorage)]",
        "    B <-->|자동 동기화| J[gdrive.js <br> Google Drive API]",
        "```"
    ])

    return (
        "# 📄 EPUB Web Viewer - 기술 사양 및 파일 안내서\n"
        f"> **기준 경로**: `{root_dir_name}` | **구조**: Ultra-Compact Modular Specs (Optimized for LLM Context)\n\n"
        "> **[🤖 AI Context Instructions]**\n"
        "> - **Architecture**: `main.js` -> `viewerCore.js` -> `bookLoader.js`/`txtParser.js` -> `view.js`(iframe 격리) -> `db.js`/`gdrive.js`\n"
        "> - **Isolation Rule**: iframe 본문 스타일 오버라이드는 `viewerCore.js`를 거쳐 주입합니다.\n"
        "> - **Code Policy**: `web/foliate-js/` 코어는 직접 수정하지 않고 Wrapper 모듈로 확장합니다. 코드 안내 시 수정 대상 함수는 Full Code를 출력합니다.\n\n"
        "---\n"
        "## 🛠 1. 전체 시스템 아키텍처 흐름\n"
        f"{mermaid_block}\n\n"
        "---\n"
        "## 📁 2. 파일 카탈로그 요약\n"
    )


# ==========================================
# 4. 메인 실행 진입점 (Main Routine)
# ==========================================

def main():
    current_work_dir = Path.cwd().resolve()
    logger.info(f"🚀 [make.py] 초경량 25KB급 사양서 작성 시작: {current_work_dir}")

    file_entries = []
    foliate_other_files = []
    css_files = []

    for path in current_work_dir.rglob("*"):
        if not path.is_file():
            continue
            
        if any(ex in path.parts for ex in EXCLUDE_DIRS):
            continue
        if path.name in EXCLUDE_FILES:
            continue
            
        # 단순 JSON 데이터 배제
        if path.name.startswith("achievements-") and path.suffix == ".json":
            continue

        if path.suffix not in {".js", ".html", ".css", ".json", ".ts", ".tsx"}:
            continue

        rel_path = path.relative_to(current_work_dir)
        rel_path_str = rel_path.as_posix()
        
        # 1. CSS 파일 묶음 감지
        if rel_path_str.endswith(".css"):
            css_files.append((path.name, path.stat().st_size, len(path.read_text(encoding="utf-8", errors="ignore").splitlines())))
            continue

        # 2. Foliate 코어 파일 중 3대 핵심 파일 외의 기타 코어 감지
        if "foliate-js" in rel_path_str and path.name not in CORE_FOLIATE_HIGHLIGHTS:
            foliate_other_files.append((path.name, path.stat().st_size, len(path.read_text(encoding="utf-8", errors="ignore").splitlines())))
            continue

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

    logger.info(f"선별 완료: 핵심 {len(file_entries)}개 파일 / 코어 요약 {len(foliate_other_files)}개 / CSS {len(css_files)}개. 빌드 시작...")

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

        # Foliate 코어 카테고리 렌더링 시 요약 행 추가
        if cat_name == "Foliate-js Core Engine (오픈소스 코어)":
            md_lines.append(f"### 🖥️ {cat_name}")
            md_lines.append("| 파일명 | 파일 경로 | 라인 | 용량 | 역할 요약 |")
            md_lines.append("| :--- | :--- | :---: | :---: | :--- |")
            for item in sorted(entries, key=lambda x: x["name"].lower()):
                role_label = item['summary']
                if item['name'] == 'paginator.js':
                    role_label = "🌟 [커스텀 포크] 한국 웹소설 전용 6대 패치 탑재 다단 페이지네이터 연산 엔진"
                elif item['name'] == 'view.js':
                    role_label = "iframe 격리 웹뷰 생성 및 뷰어 라이프사이클 제어"
                elif item['name'] == 'epub.js':
                    role_label = "EPUB OPF 패키지 파서 및 인메모리 도서 인스턴스화"
                md_lines.append(f"| **`{item['name']}`** | `{item['path']}` | {item['lines']} | {item['size']} | {role_label} |")
            
            # 20개 기타 코어 1줄 요약 행 삽입
            if foliate_other_files:
                other_lines = sum(x[2] for x in foliate_other_files)
                other_size = format_file_size(sum(x[1] for x in foliate_other_files))
                md_lines.append(f"| **`foliate-js 기타 코어`** | `foliate-js/ ({len(foliate_other_files)}개 모듈)` | {other_lines} | {other_size} | 기타 규격(mobi, fb2, pdf 등) 파서 및 보조 유틸리티 (규칙 4에 의해 보존) |")
            md_lines.append("\n")
            continue

        # Styles & Config 카테고리 렌더링 시 CSS 1줄 요약 행 추가
        if cat_name == "Styles & Config (스타일 및 설정)":
            md_lines.append(f"### 🖥️ {cat_name}")
            md_lines.append("| 파일명 | 파일 경로 | 라인 | 용량 | 역할 요약 |")
            md_lines.append("| :--- | :--- | :---: | :---: | :--- |")
            if css_files:
                css_lines = sum(x[2] for x in css_files)
                css_size = format_file_size(sum(x[1] for x in css_files))
                css_names = ", ".join([Path(x[0]).stem for x in css_files])
                md_lines.append(f"| **`UI 스타일 시트`** | `src/styles/*.css ({len(css_files)}개 파일)` | {css_lines} | {css_size} | 뷰어/서재 BEM 레이아웃 스타일 ({css_names}) |")
            for item in sorted(entries, key=lambda x: x["name"].lower()):
                md_lines.append(f"| **`{item['name']}`** | `{item['path']}` | {item['lines']} | {item['size']} | {item['summary']} |")
            md_lines.append("\n")
            continue

        if not entries:
            continue

        md_lines.append(f"### 🖥️ {cat_name}")
        md_lines.append("| 파일명 | 파일 경로 | 라인 | 용량 | 역할 요약 |")
        md_lines.append("| :--- | :--- | :---: | :---: | :--- |")
        
        for item in sorted(entries, key=lambda x: x["name"].lower()):
            md_lines.append(f"| **`{item['name']}`** | `{item['path']}` | {item['lines']} | {item['size']} | {item['summary']} |")
        
        md_lines.append("\n")

    # 섹션 3: 핵심 모듈 공개 인터페이스 (Public APIs) 고밀도 인라인 렌더링
    md_lines.append("---\n## 🧩 3. 핵심 모듈 공개 인터페이스 (Public APIs)\n")
    md_lines.append("> *수정 및 확장 대상이 되는 핵심 모듈의 의존성 및 Export 인터페이스 명세입니다.*\n")

    # EntryPoint 및 web/src 하위 모듈만 선별 (foliate-js 완벽 제외)
    target_api_entries = [
        e for e in file_entries 
        if e["category"] in [
            "EntryPoint (앱 진입점)",
            "Core Engine (코어 조판 & 라이프사이클)",
            "Data Loaders & Parsers (도서 로딩 & TXT 파서)",
            "Storage & Cloud Services (스토리지 & 클라우드 대사)",
            "Hardware Input & Events (입력 제어 & 제스처)",
            "UI Controllers & Modals (서재 & 설정 패널)"
        ] and e["path"].endswith(".js")
    ]

    for item in sorted(target_api_entries, key=lambda x: x["path"].lower()):
        # 의존성과 시그니처가 둘 다 없는 빈 파일은 렌더링 스킵
        if not item["deps"] and not item["signatures"]:
            continue

        # 🌟 [다이어트 핵심 1] 중복 설명문 제거: 경로만 깔끔하게 출력
        md_lines.append(f"#### 📄 `{item['path']}`")
        
        # 1. 참조 모듈 출력 (Dependencies)
        if item["deps"]:
            deps_str = ", ".join([f"`{d}`" for d in item["deps"]])
            md_lines.append(f"- **참조 (Dependencies)**: {deps_str}")

        # 2. 🌟 [다이어트 핵심 2] 핵심 구현 함수/클래스 인라인 표기
        if item["signatures"]:
            sigs_str = ", ".join([f"`{s}`" for s in item["signatures"]])
            md_lines.append(f"- **핵심 API (Exports)**: {sigs_str}")
        
        md_lines.append("")

    # 🎯 현재 폴더에 '파일안내.md' 기록
    output_path = current_work_dir / "파일안내.md"
    output_path.write_text("\n".join(md_lines), encoding="utf-8")
    
    final_output_size = format_file_size(output_path.stat().st_size)
    logger.info(f"🎉 [성공] 초경량 다이어트 완료: {output_path} (크기: {final_output_size})")


if __name__ == "__main__":
    main()