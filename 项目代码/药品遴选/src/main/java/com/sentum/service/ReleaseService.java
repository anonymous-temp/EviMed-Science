package com.sentum.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.dto.FileInfoUploadDto;
import com.sentum.pojo.vo.PageVo;
import com.sentum.pojo.vo.ReleaseDataVo;

/**
 * 发布页服务层
 * @author zgm
 */
public interface ReleaseService {
    /**
     * 发布列表页信息
     * @param searchInfo 用户输入框的检索条件可以为null
     * @param pageNum 当前页
     * @param pageSize 每页大小
     * @return 分页后的发布页信息
     */
    PageVo<ReleaseDataVo> releaseInfo(String searchInfo, Integer pageNum, Integer pageSize, Long userId);

    /**
     * 当用户上传报告时回显用户信息
     * @param token token
     * @return 需要回显的部分用户信息
     */
    JSONObject echoUserInfo(String token);

    /**
     * 用户上传报告
     * @param fileInfoUploadDto 上传的请求dto类
     * @return 成功返回true
     */
    Boolean upload(FileInfoUploadDto fileInfoUploadDto);

    /**
     * 用户收藏报告
     * @param releaseId 报告id
     * @param userId 用户id
     * @param status true收藏、false取消收藏
     * @return 成功true
     */
    Boolean collect(String releaseId, Long userId, Boolean status);
}
