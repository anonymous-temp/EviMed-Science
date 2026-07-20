package com.sentum.util;

import java.security.MessageDigest;

/**
 * 加密算法
 * @author 马亚民
 *
 */
public class SecurityUtil {
	public static String getMd5(String s, String charsetName) {
		char[] hexDigits = { '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
				'a', 'b', 'c', 'd', 'e', 'f' };
		try {
			byte[] strTemp;
			if(charsetName==null||"".equals(charsetName)) {
				strTemp = s.getBytes();
			}
			else {
				strTemp = s.getBytes(charsetName);
			}
			MessageDigest mdTemp = MessageDigest.getInstance("MD5");
			mdTemp.update(strTemp);
			byte[] md = mdTemp.digest();
			int j = md.length;
			char[] str = new char[j * 2];
			int k = 0;
			for (byte byte0 : md) {
				str[k++] = hexDigits[byte0 >>> 4 & 0xf];
				str[k++] = hexDigits[byte0 & 0xf];
			}
			return new String(str);
		} catch (Exception e) {
			return null;
		}

	}
	
	/**
	 * 默认使用utf-8编码
	 * @param s 需要转化的字符串
	 * @return 返回该字符串的MD5编码
	 */
	public static String getMd5(String s) {
		return getMd5(s,"UTF-8");
	}
}
