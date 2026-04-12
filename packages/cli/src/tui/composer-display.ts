export function renderComposerDisplay(
  inputValue: string,
  placeholder: string,
  showCursor: boolean,
): { readonly text: string; readonly cursor: string; readonly isPlaceholder: boolean } {
  if (!inputValue) {
    return {
      text: placeholder,
      cursor: showCursor ? "│" : "",
      isPlaceholder: true,
    };
  }

  return {
    text: inputValue,
    cursor: showCursor ? "│" : "",
    isPlaceholder: false,
  };
}
