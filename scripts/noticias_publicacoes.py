

def set_source_interruption(metric: dict, error: Exception, *, progress: int, resume_saved: bool = False) -> None:
    """Normalize interruption metadata for a single source without claiming a complete run."""
    metric["interruption_reason"] = safe_error(error)
    metric["continuation_available"] = bool(resume_saved)
    metric["resume_possible"] = bool(resume_saved)
    metric["resume_status"] = "continuation_saved" if resume_saved else "restart_required"
    metric["request_status"] = "partial" if progress else "failed"
    metric["collection_status"] = "partial" if progress else "failed"


# existing function after abstract_from_openalex

def abstract_from_openalex(work: dict) -> str:
    inverted = work.get("abstract_inverted_index") or {}
    words: dict[int, str] = {}
    for word, positions in inverted.items():
        for position in positions:
            words[position] = word
    return " ".join(words[index] for index in sorted(words))


# existing function below continue...
