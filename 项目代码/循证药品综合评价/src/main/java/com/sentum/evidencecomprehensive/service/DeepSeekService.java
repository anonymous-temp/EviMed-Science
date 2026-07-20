package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.dto.ai.GuideDS;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/2/10
 */
public interface DeepSeekService {

    List<GuideDS> searchGuideTop5(String drug, String disease);
}
