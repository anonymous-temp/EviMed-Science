package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;

/**
 * 站内信相关逻辑
 * @author zgm
 */
public interface MailService {
    /**
     * 创建课题成功时的站内信
     * @param id 课题id
     * @param userId 用户id
     * @return 站内信内容
     */
    String create(String id, Long userId);

    /**
     * 获取站内信列表及是否有未读内容查询
     * @param userId 用户id
     * @param pageSize 每页大小
     * @param pageNum 当前页数
     * @return 站内信列表信息及是否有未读
     */
    JSONObject list(Long userId, Integer pageSize, Integer pageNum);

    /**
     * 根据站内信的id修改其状态为已读
     *
     * @param id      站内信id
     * @param allRead  truw 
     * @param userId
     * @return 成功true
     */
    Boolean read(String id, Boolean allRead, long userId);
}
