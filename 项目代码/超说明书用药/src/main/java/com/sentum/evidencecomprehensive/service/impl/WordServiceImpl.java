package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.util.StrUtil;
import com.sentum.evidencecomprehensive.service.WordService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

/**
 * @Description: word等 线下报告service
 */
@Slf4j
@Service
public class WordServiceImpl implements WordService {
    private final MongoTemplate mongoTemplate;

    public WordServiceImpl(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     *
     * @param content 原文
     * @param oldChar 被替换的内容
     * @param newChar 需要替换的内容
     */
    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) return "";
        content = content.replaceAll(oldChar, newChar);
        return content;
    }

}
