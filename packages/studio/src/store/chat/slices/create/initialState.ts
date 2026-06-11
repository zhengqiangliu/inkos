import type { CreateState } from "../../types";

export const initialCreateState: CreateState = {
  bookCreating: false,
  createProgress: "",
  bookDataVersion: 0,
  sidebarView: "panel",
  artifactSource: "truth",
  artifactFile: null,
  artifactChapter: null,
  artifactChapterMeta: null,
  artifactEditMode: false,
  bookSummary: null,
};
