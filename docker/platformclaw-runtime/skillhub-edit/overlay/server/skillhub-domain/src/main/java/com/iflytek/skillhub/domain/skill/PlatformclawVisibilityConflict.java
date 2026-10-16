package com.iflytek.skillhub.domain.skill;

import com.iflytek.skillhub.domain.shared.exception.LocalizedDomainException;

/** Version publication cannot silently undo an explicit registry visibility edit. */
public class PlatformclawVisibilityConflict extends LocalizedDomainException {
    public PlatformclawVisibilityConflict() { super("Complete registry visibility review or edit visibility before publishing a version"); }
    public PlatformclawVisibilityConflict(String message) { super(message); }
    @Override public int statusCode() { return 409; }
}
