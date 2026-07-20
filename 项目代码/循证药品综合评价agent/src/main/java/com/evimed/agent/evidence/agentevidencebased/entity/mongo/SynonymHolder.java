package com.evimed.agent.evidence.agentevidencebased.entity.mongo;

import java.util.List;

/**
 * 同义词持有者接口
 * 用于统一 Drug、Disease、InterventionAndOutcome 类的同义词设置
 */
public interface SynonymHolder {

    /**
     * 设置中文同义词
     */
    void setZhSynonym(List<String> zhSynonym);

    /**
     * 设置英文同义词
     */
    void setEnSynonym(List<String> enSynonym);

    /**
     * 设置其他同义词
     */
    void setOtherSynonym(List<String> otherSynonym);

    /**
     * 获取中文同义词
     */
    List<String> getZhSynonym();

    /**
     * 获取英文同义词
     */
    List<String> getEnSynonym();

    /**
     * 获取其他同义词
     */
    List<String> getOtherSynonym();
}
