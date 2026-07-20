package com.sentum.evidencecomprehensive.domain.vo;

import java.util.HashMap;
import java.util.Map;

public class DataResult extends HashMap<String, Object> {

	private static final long serialVersionUID = -8157613083634272196L;

	public DataResult() {
		put("code", 200);
		put("msg", "success");
	}

	public static DataResult error() {
		return error(500, "未知异常，请联系管理员");
	}

	public static DataResult error(String msg) {
		return error(500, msg);
	}

	public static DataResult error(int code, String msg) {
		DataResult r = new DataResult();
		r.put("code", code);
		r.put("msg", msg);
		return r;
	}

	public static DataResult ok(String msg) {
		DataResult r = new DataResult();
		r.put("msg", msg);
		return r;
	}

	public static DataResult data(Object obj) {
		DataResult r = new DataResult();
		r.put("data", obj);
		return r;
	}

	public static DataResult ok(Map<String, Object> map) {
		DataResult r = new DataResult();
		r.putAll(map);
		return r;
	}

	public static DataResult ok() {
		return new DataResult();
	}

	@Override
	public DataResult put(String key, Object value) {
		super.put(key, value);
		return this;
	}
}