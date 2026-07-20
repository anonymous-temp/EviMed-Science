package com.sentum.drugsafe.service;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.itextpdf.text.DocumentException;

import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;

/**
 * 药物警戒service类
 * @author zgm
 */
public interface AlertService {
    /**
     * 药物警戒判断输入条件的类型，并将处理后的数据存储，保存历史记录
     * @param condition 用户的检索条件
     * @param userId 用户id
     * @return 多种状态，用于后续的检索
     */
    JSONObject analyse(String condition, Long userId);

    /**
     * 当type=3时即用户输入条件为不良反应，检索不良反应对应的干预措施
     * @param id 检索id
     * @param searchData 检索框输入内容
     * @return 当前页的推荐干预措施
     */
    JSONObject findIForOnlyO(String id, String searchData, Integer pageSize, Integer pageNum, Integer sort);

    /**
     * 当type=3时即用户输入条件为不良反应，检索不良反应对应的干预措施
     * @param id 检索id
     * @param searchData 检索框输入内容
     * @param pageSize 每页大小
     * @param pageNum 当前页数
     * @param choice choice=1 + ；0 -
     * @return 当前页的推荐干预措施
     */
    JSONObject findIForOnlyOApp(String id, String searchData, Integer pageSize, Integer pageNum, Integer choice);

    /**
     * 分析综述
     * @param id 检索id
     * @param type type=1 fda type=2 vigi
     * @return 综述的内容
     */
    JSONObject analysisOverview(String id, Integer type);

    /**
     * 返回药物警戒的全部信息
     * @param id 检索id
     * @param type type=1 fda type=2 vigi
     * @return 合并起来的返回前端
     */
    JSONObject searchAll(String id, Integer type);

    /**
     * 下载药物警戒分析报告
     * @param id 检索id
     */
    void download(String id, HttpServletResponse response) throws DocumentException, IOException;

    /**
     * 下载word版本的药物警戒分析报告
     * @param id 检索id
     */
    void downloadWord(String id, HttpServletResponse response) throws DocumentException, IOException, com.lowagie.text.DocumentException;

    /**
     * 查询用户的检索历史记录
     * @param userId 用户id
     * @return 10条时间由近及远的历史记录，多余的删除
     */
    JSONArray showHistory(Long userId,String type);

    /**
     * 根据历史记录id删除历史记录
     * @param ids 历史记录id
     * @return 成功true
     */
    Boolean deleteHistory(String ids);

    /**
     * 清空历史记录
     * @param userId 用户id
     * @return 成功true
     */
    Boolean emptyHistory(Long userId);

    /**
     * 根据用户输入词获得联想词
     * @param word 用户输入词
     * @return 由短到长的5个联想词
     */
    List<String> getAssociationalWord(String word);
}
