package com.sentum.evidencecomprehensive.service;

import javax.servlet.http.HttpServletResponse;

/**
 * @Description:
 */
public interface WordService {


    /**
     * 替换 content 中的 oldChar 为 newChar
     * @param content
     * @param oldChar
     * @param newChar
     * @return
     */
    String wiffOfContent(String content, String oldChar, String newChar);
}
