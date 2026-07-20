package com.sentum.drugsafe.pojo;

import java.util.HashMap;
import java.util.Map;

public class PicoResult extends HashMap<String, Object> {

	private static final long serialVersionUID = -8157613083634272196L;

	public PicoResult() {
		put("code", 200);
		put("msg", "success");
	}

	public static PicoResult error() {
		return error(500, "未知异常，请联系管理员");
	}

	public static PicoResult error(String msg) {
		return error(500, msg);
	}

	public static PicoResult error(int code, String msg) {
		PicoResult r = new PicoResult();
		r.put("code", code);
		r.put("msg", msg);
		return r;
	}

	public static PicoResult ok(String msg) {
		PicoResult r = new PicoResult();
		r.put("msg", msg);
		return r;
	}

	public static PicoResult data(Object obj) {
		PicoResult r = new PicoResult();
		r.put("data", obj);
		return r;
	}

	public static PicoResult ok(Map<String, Object> map) {
		PicoResult r = new PicoResult();
		r.putAll(map);
		return r;
	}

	public static PicoResult ok() {
		return new PicoResult();
	}

	@Override
	public PicoResult put(String key, Object value) {
		super.put(key, value);
		return this;
	}
}