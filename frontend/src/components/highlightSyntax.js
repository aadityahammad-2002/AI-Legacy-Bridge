/**
 * highlightSyntax.js
 *
 * A lightweight, dependency-free per-line regex tokenizer — ported line-for-line
 * so RepositoryPanel's source viewer produces the exact same token classes and
 * colors (see RepositoryPanel.css's `.syn-*` rules)
 * instead of plain unstyled text.
 *
 * Returns an array of HTML-safe strings, one per source line, with `<span
 * class="syn-*">` wrapping around comments/strings/numbers/keywords/function
 * calls/types. Callers must render these with dangerouslySetInnerHTML (safe
 * here because `esc()` escapes all user/file content before any span is added
 * — the only unescaped HTML is the literal `<span class="syn-*">` tags this
 * function itself inserts).
 */
export function highlightSyntax(code, filename) {
    if (!code) return [];
    const ext = (filename || '').split('.').pop().toLowerCase();
    const isJS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext);
    const isPy = ['py', 'pyw', 'pyi'].includes(ext);
    const isJava = ['java', 'kt', 'scala', 'cs', 'go'].includes(ext);
    const isHTML = ['html', 'htm', 'vue', 'svelte'].includes(ext);
    const isCSS = ['css', 'scss', 'sass', 'less'].includes(ext);
    const isRuby = ['rb', 'rake'].includes(ext);
    const isPHP = ext === 'php';

    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    return code.split('\n').map((line) => {
        let escaped = esc(line);

        if (isJS || isJava || isPHP || isCSS) escaped = escaped.replace(/(\/\/.*$)/gm, '<span class="syn-com">$1</span>');
        if (isPy || isRuby) escaped = escaped.replace(/(#.*$)/gm, '<span class="syn-com">$1</span>');
        if (isHTML) escaped = escaped.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="syn-com">$1</span>');

        escaped = escaped.replace(/(&quot;[^&]*&quot;|'[^']*'|`[^`]*`)/g, '<span class="syn-str">$1</span>');
        escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, '<span class="syn-num">$1</span>');

        if (isJS) {
            escaped = escaped.replace(
                /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|from|default|async|await|yield|typeof|instanceof|in|of|this|super|null|undefined|true|false|void|static|get|set)\b/g,
                '<span class="syn-kw">$1</span>'
            );
        }
        if (isPy) {
            escaped = escaped.replace(
                /\b(async|await|def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|pass|break|continue|lambda|yield|global|nonlocal|assert|True|False|None|and|or|not|in|is|del|match|case|type)\b/g,
                '<span class="syn-kw">$1</span>'
            );
            escaped = escaped.replace(/(@\w+)/g, '<span class="syn-fn">$1</span>');
        }
        if (isJava) {
            escaped = escaped.replace(
                /\b(public|private|protected|static|final|void|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|import|package|this|super|null|true|false)\b/g,
                '<span class="syn-kw">$1</span>'
            );
        }
        if (isRuby) {
            escaped = escaped.replace(
                /\b(def|class|module|end|return|if|elsif|else|unless|case|when|for|while|until|do|begin|rescue|ensure|raise|require|include|extend|attr_accessor|attr_reader|attr_writer|true|false|nil|self)\b/g,
                '<span class="syn-kw">$1</span>'
            );
        }
        if (isPHP) {
            escaped = escaped.replace(
                /\b(function|class|return|if|else|elseif|for|foreach|while|do|switch|case|break|continue|try|catch|finally|throw|new|public|private|protected|static|const|use|namespace|extends|implements|true|false|null)\b/g,
                '<span class="syn-kw">$1</span>'
            );
        }
        if (isCSS) escaped = escaped.replace(/(@media|@import|@keyframes|@font-face|!important)/g, '<span class="syn-kw">$1</span>');
        if (isHTML) {
            escaped = escaped.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="syn-tag">$2</span>');
            escaped = escaped.replace(/([\w-]+)(=)/g, '<span class="syn-attr">$1</span>$2');
        }

        escaped = escaped.replace(/\b([a-zA-Z_]\w*)\s*\(/g, '<span class="syn-fn">$1</span>(');
        if (isJS || isJava) escaped = escaped.replace(/:\s*([A-Z]\w*)/g, ': <span class="syn-type">$1</span>');

        return escaped;
    });
}
