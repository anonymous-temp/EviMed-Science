package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.QuestionUpdateVo;
import com.sentum.evidencecomprehensive.pojo.vo.QuestionVo;

import javax.servlet.http.HttpServletRequest;
import java.util.List;

/**
 * 课题页面相关逻辑
 * @author zgm
 */
public interface QuestionService {
    /**
     * 根据检索id生成课题
     * @param id 检索id
     * @param userId 用户id
     * @return 成功true
     */
    String create(String id, Long userId, HttpServletRequest request);

    /**
     * 修改课题名称
     * @param questionUpdateVo 修改的课题
     * @return 成功true
     */
    Boolean updateName(QuestionUpdateVo questionUpdateVo);

    /**
     * 根据课题id获取课题名称
     * @param id 课题id
     * @return 课题名称
     */
    String getName(String id);

    /**
     * 查询课题列表
     * @param userId 用户id
     * @param type 1-全部课题；2-我的课题；3-收藏课题；4-分享课题
     * @param search 用户输入的检索词
     * @param pageSize 每页大小
     * @param pageNum 当前页
     * @param sortType 排序类型，1-创建时间排序，2-最后操作时间排序，0-默认排序
     * @param direction 排序方向，1-正序，2-倒叙
     * @return 课题列表
     */
    PageVo<QuestionVo> list(Long userId, Integer type, String search, Integer pageSize, Integer pageNum, Integer sortType, Integer direction, HttpServletRequest request);

    /**
     * 批量/单个删除课题数据
     * @param ids 课题id的集合
     * @return 成功true
     */
    Boolean delete(List<String> ids);

    /**
     * 批量/单个收藏/取消收藏课题
     * @param ids 课题id的集合
     * @param status 1-收藏；0-取消收藏
     * @return 成功true
     */
    Boolean collect(List<String> ids, Integer status);

    /**
     * 新增课题的历史记录
     * @param id 课题id
     * @return 成功true
     */
    Boolean insertHistory(String id);

    /**
     * 根据课题id查询历史课题
     * @param id 课题id
     * @return 历史课题列表
     */
    List<QuestionVo> history(String id);

    /**
     * 根据课题id创建分享链接
     * @param id 被分享的课题id
     * @param userId 用户id
     * @return 分享链接
     */
    String createShareUrl(String id, Long userId);

    /**
     * 根据分享链接创建课题
     * @param tarId 分享的课题id
     * @param tarUserId 分享人的用户id
     * @param userId 使用链接人的id
     * @return 成功true
     */
    Boolean share(String tarId, Long tarUserId, Long userId, HttpServletRequest request);

    /**
     * 根据课题id判断当前课题跳转的页面
     * @param id 课题id
     * @return 1-检索页面；2-证据列表页面
     */
    Integer determine(String id);
}
