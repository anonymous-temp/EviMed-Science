package com.sentum.evidencecomprehensive.service;

import javax.servlet.http.HttpServletResponse;

/**
 * @Description: word 下载
 */
public interface WordService {
    /**
     * 决策报告 word下载
     *
     * @param id
     * @param source
     * @param response
     */
    void downloadEvidenceBasedReportWord(String id, String source, HttpServletResponse response);

    /**
     * 替换 content 中的 oldChar 为 newChar
     * @param content
     * @param oldChar
     * @param newChar
     * @return
     */
    String wiffOfContent(String content, String oldChar, String newChar);
}
